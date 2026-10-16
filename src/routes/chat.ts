import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getPublicModels, normalizeEffort, resolveRuntimeModel } from "../config/models.js";
import { t } from "../i18n/index.js";
import type { AccountStore } from "../lib/accounts/store.js";
import { AccountService } from "../lib/accounts/service.js";
import { isDefinitive, isPoolRateLimited, UpstreamError } from "../lib/antigravity/errors.js";
import { AllAccountsFailedError, TurnRunner } from "../lib/chat/turn.js";
import { toResetPhrase } from "../lib/format/datetime.js";
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
 * The upstream classifies a definitive failure by *why* it refused; the caller must see
 * the same distinction. A `model_not_found` is a 404 naming the model, but a
 * `client_error` (400 — a rejected request) or a `license` (403) is not a missing model
 * and must keep its own status and message: collapsing every definitive error onto 404
 * "not found" sent the caller to the catalog when the request was what the backend
 * refused (spec D12).
 *
 * A pool that failed only on rate limits is the one case that must NOT be a 503: a 503
 * `server_error` reads as "retry now". A retryable 429 did not help either — measured, the
 * client re-issued every ~0.5s while stuck in "thinking", so the loop never ended. It is
 * reported as a 400 the client treats as final, naming the model and saying to try another.
 */
function mapTurnError(
  error: unknown,
  model: string,
  fallback: number,
  poolDetail: string,
): { status: number; body: { error: unknown } } {
  if (error instanceof UpstreamError && error.kind === "model_not_found") {
    return toOpenAIErrorBody(
      new Error(t("chat.modelRejected", { model, detail: error.message })),
      404,
    ) as { status: number; body: { error: unknown } };
  }
  if (error instanceof UpstreamError && isDefinitive(error.kind)) {
    return toOpenAIErrorBody(
      new Error(t("chat.modelRejected", { model, detail: error.message })),
      error.status,
    ) as { status: number; body: { error: unknown } };
  }
  if (error instanceof AllAccountsFailedError && (isPoolRateLimited(error.failures) || error.failures.length === 0)) {
    // The pool is drained by quota, or empty (every account in cooldown). A retryable
    // status kept the client re-issuing — measured at ~0.5s — so the loop never ended. A
    // 400 it treats as final is what makes it stop. A pool that failed on a real transient
    // (all `server_error`) is NOT this case and keeps its 503.
    return toOpenAIErrorBody(new Error(poolDetail), 400) as { status: number; body: { error: unknown } };
  }
  return toOpenAIErrorBody(error, fallback) as { status: number; body: { error: unknown } };
}

/**
 * The message a drained or empty pool answers with, and that the request logs — the same
 * text in both places so the terminal explains the client's error without a second lookup.
 */
function poolDetailMessage(model: string, soonestCooldownUntil: number | null): string {
  const reset = toResetPhrase(soonestCooldownUntil);
  return reset
    ? t("chat.poolEmpty", { model, reset })
    : t("chat.poolEmptyNoReset", { model });
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
    // Correlates every line of this turn with the reqId Fastify already logs. The
    // request log carries it; the runner and the upstream layer get this same logger.
    const log = request.log;
    const requestStart = Date.now();
    log.debug(
      {
        model: body.model,
        stream: Boolean(body.stream),
        messages: body.messages?.length ?? 0,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        reasoning_effort: body.reasoning_effort ?? null,
      },
      "chat request",
    );

    if (!getPublicModels().some((model) => model.id === body.model)) {
      log.warn({ model: body.model }, "model not in catalog");
      const mapped = toOpenAIErrorBody(new Error(t("chat.modelNotFound", { model: body.model })), 404);
      reply.status(404).send(mapped.body);
      return;
    }

    const effort = normalizeEffort(body.reasoning_effort);
    const runtimeModel = resolveRuntimeModel(body.model, effort);

    let contents;
    let systemInstruction: string;
    try {
      // Native Gemini rejects an unsigned functionCall history; the 3p bridge does not
      // care. Strictness only pays where the rule exists.
      ({ contents, systemInstruction } = toContents(body.messages, {
        strictThoughtSignatures: runtimeModel.startsWith("gemini-"),
      }));
    } catch (error) {
      log.warn(
        { model: body.model, err: error instanceof Error ? error.message : String(error) },
        "invalid messages",
      );
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
      ? new AccountService({ store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl, logger: log })
      : getAccountService(deps.env, log);
    const runner = new TurnRunner({ accounts, env: deps.env, fetchImpl: deps.fetchImpl, logger: log });
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
        const { result, accountId } = await runner.run(turnInput, { signal: disconnect.signal });
        log.info(
          {
            model: body.model,
            runtimeModel,
            accountId,
            stream: false,
            finishReason: result.finishReason,
            toolCalls: result.toolCalls.length,
            tokens: result.usage?.total_tokens ?? null,
            elapsedMs: Date.now() - requestStart,
          },
          "chat completed",
        );
        reply.status(200).send(buildCompletion(result, body.model));
      } catch (error) {
        const poolDetail = poolDetailMessage(body.model, accounts.poolSummary().soonestCooldownUntil);
        const mapped = mapTurnError(error, body.model, error instanceof AllAccountsFailedError ? 503 : 502, poolDetail);
        log.warn(
          {
            model: body.model,
            runtimeModel,
            status: mapped.status,
            kind: error instanceof UpstreamError ? error.kind : "pool",
            detail: (mapped.body.error as { message?: string }).message,
            elapsedMs: Date.now() - requestStart,
          },
          "chat failed",
        );
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
      const { result, accountId } = await runner.run(turnInput, {
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
      log.info(
        {
          model: body.model,
          runtimeModel,
          accountId,
          stream: true,
          finishReason: result.finishReason,
          toolCalls: result.toolCalls.length,
          tokens: result.usage?.total_tokens ?? null,
          elapsedMs: Date.now() - requestStart,
        },
        "chat completed",
      );
    } catch (error) {
      const poolDetail = poolDetailMessage(body.model, accounts.poolSummary().soonestCooldownUntil);
      const mapped = mapTurnError(error, body.model, error instanceof AllAccountsFailedError ? 503 : 502, poolDetail);
      log.warn(
        {
          model: body.model,
          runtimeModel,
          status: mapped.status,
          kind: error instanceof UpstreamError ? error.kind : "pool",
          detail: (mapped.body.error as { message?: string }).message,
          headersSent: started,
          elapsedMs: Date.now() - requestStart,
        },
        "chat failed",
      );
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
