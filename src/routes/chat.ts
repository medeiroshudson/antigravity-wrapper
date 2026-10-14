import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getPublicModels, normalizeEffort, resolveRuntimeModel } from "../config/models.js";
import { t } from "../i18n/index.js";
import type { AccountStore } from "../lib/accounts/store.js";
import { AccountService } from "../lib/accounts/service.js";
import { isDefinitive, UpstreamError } from "../lib/antigravity/errors.js";
import { AllAccountsFailedError, TurnRunner } from "../lib/chat/turn.js";
import { toContents, type ChatMessage } from "../lib/chat/compose.js";
import {
  buildFunctionDeclarations,
  extractToolDefs,
  toolInstruction,
} from "../lib/chat/tools.js";
import { getAccountService } from "../lib/runtime.js";
import {
  buildChunk,
  buildCompletion,
  sseEvent,
  SSE_DONE,
  toOpenAIErrorBody,
} from "../lib/openai-format/index.js";

interface ChatBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  reasoning_effort?: unknown;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}

const bodySchema = {
  body: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string" },
      messages: { type: "array", minItems: 1, items: { type: "object", required: ["role"] } },
      stream: { type: "boolean" },
      reasoning_effort: {},
      max_tokens: { type: "integer" },
      tools: { type: "array" },
      tool_choice: {},
    },
  },
} as const;

/**
 * A definitive upstream failure is about the request, not the pool, so it is reported with
 * the model named and as a 404. Everything else keeps its existing mapping (spec D12).
 */
function mapTurnError(
  error: unknown,
  model: string,
  fallback: number,
): { status: number; body: { error: unknown } } {
  if (error instanceof UpstreamError && isDefinitive(error.kind)) {
    return toOpenAIErrorBody(
      new Error(t("chat.modelRejected", { model, detail: error.message })),
      404,
    ) as { status: number; body: { error: unknown } };
  }
  return toOpenAIErrorBody(error, fallback) as { status: number; body: { error: unknown } };
}

/**
 * Aborts the upstream only on a real disconnect: `writableFinished` distinguishes
 * the normal end (response finished before the socket) from a client that went
 * away. Listening on `request.raw` would be wrong — it fires when the body
 * finishes being read.
 */
export function wireClientDisconnect(
  res: { on(event: "close", cb: () => void): void; writableFinished: boolean },
  controller: AbortController,
): void {
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
}

export async function chatRoutes(
  app: FastifyInstance,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; store?: AccountStore } = {},
): Promise<void> {
  app.post<{ Body: ChatBody }>("/v1/chat/completions", { schema: bodySchema }, async (request, reply) => {
    const body = request.body;

    if (!getPublicModels().some((model) => model.id === body.model)) {
      const mapped = toOpenAIErrorBody(new Error(t("chat.modelNotFound", { model: body.model })), 404);
      reply.status(404).send(mapped.body);
      return;
    }

    const effort = normalizeEffort(body.reasoning_effort);
    const runtimeModel = resolveRuntimeModel(body.model, effort);

    let contents;
    let systemInstruction: string;
    try {
      ({ contents, systemInstruction } = toContents(body.messages));
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    const tools = extractToolDefs(body);
    const declarations = buildFunctionDeclarations(tools, runtimeModel);
    // `toolInstruction` already implements the spec table: `auto`/absent -> null;
    // `none`/`required`/named -> instruction without a fence. There is nothing
    // left to suppress — the old guard nullified all three cases and disabled
    // the emulation.
    const instruction = toolInstruction(tools, body.tool_choice);
    const system = instruction ? `${systemInstruction}\n\n${instruction}` : systemInstruction;

    // The injected store (buildServer) must win: the runtime.ts singletons
    // exist for the production entrypoint, not for the route under test.
    const accounts = deps.store
      ? new AccountService({ store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl })
      : getAccountService(deps.env);
    const runner = new TurnRunner({ accounts, env: deps.env, fetchImpl: deps.fetchImpl });
    const turnInput = {
      runtimeModel,
      contents,
      systemInstruction: system,
      effort,
      tools: declarations,
      maxTokens: body.max_tokens,
    };

    // The signal comes from the `reply`, never from `request.signal`: the latter
    // is derived from the IncomingMessage `close`, which fires as soon as the
    // request body finishes being read (~0ms), not when the client disconnects.
    // Chaining it cancelled the upstream call on every request, before it left.
    // `writableFinished` distinguishes the normal end of the response from a
    // client that vanished.
    const disconnect = new AbortController();
    wireClientDisconnect(reply.raw, disconnect);

    if (!body.stream) {
      try {
        const { result } = await runner.run(turnInput, { signal: disconnect.signal });
        reply.status(200).send(buildCompletion(result, body.model));
      } catch (error) {
        const mapped = mapTurnError(error, body.model, error instanceof AllAccountsFailedError ? 503 : 502);
        reply.status(mapped.status).send(mapped.body);
      }
      return;
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let started = false;
    let roleSent = false;

    const writeChunk = (delta: Record<string, unknown>, finish: string | null): void => {
      if (!started) {
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      }
      const payload = roleSent ? delta : { role: "assistant", ...delta };
      roleSent = true;
      reply.raw.write(sseEvent(buildChunk(id, body.model, created, payload, finish)));
    };

    try {
      const { result } = await runner.run(turnInput, {
        signal: disconnect.signal,
        onDelta: (text) => {
          if (disconnect.signal.aborted || reply.raw.destroyed) throw new Error(t("chat.clientDisconnected"));
          writeChunk({ content: text }, null);
        },
      });
      for (const [index, call] of result.toolCalls.entries()) {
        writeChunk(
          {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
                // Only when present: keeps the frame identical to today's without a signature.
                ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
              },
            ],
          },
          null,
        );
      }
      writeChunk({}, result.finishReason);
      reply.raw.write(SSE_DONE);
    } catch (error) {
      const mapped = mapTurnError(error, body.model, error instanceof AllAccountsFailedError ? 503 : 502);
      if (started) {
        // Headers already on the wire: the error becomes a frame, followed by an
        // explicit [DONE] so the client does not read the silence as a truncated
        // stream.
        reply.raw.write(sseEvent({ error: mapped.body.error }));
        reply.raw.write(SSE_DONE);
      } else {
        reply.status(mapped.status).send(mapped.body);
        return;
      }
    } finally {
      if (started) reply.raw.end();
    }
  });
}
