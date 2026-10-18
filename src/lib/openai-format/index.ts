// OpenAI-compatible format layer.
// Turns a TurnResult into OpenAI responses, SSE chunks and error bodies.

import { randomUUID } from "node:crypto";
import type { Warning } from "../chat/diagnostics.js";
import {
  extractStructuredGrounding,
  type GroundingMetadata,
  type StructuredGrounding,
} from "../chat/grounding.js";

export interface TurnResult {
  content: string;
  finishReason: string;
  usage: Usage | null;
  toolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }>;
  warnings?: Warning[];
  groundingMetadata?: GroundingMetadata;
}

export type CompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

export type Usage = CompletionUsage;

export type CompletionToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Non-standard field: the only channel an OpenAI-shaped response has for
   * returning Gemini's `thoughtSignature`. Without it a stateless client cannot
   * echo the signature on the next turn and the backend refuses the multi-turn
   * continuation (spec §8).
   */
  thoughtSignature?: string;
};

export type CompletionChoice = {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: CompletionToolCall[];
    grounding_metadata?: StructuredGrounding;
  };
  finish_reason: string | null;
};

export type ChatCompletion = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: Usage;
  warnings?: Warning[];
};

export type DeltaToolCall = {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Ver `CompletionToolCall.thoughtSignature`. */
  thoughtSignature?: string;
};

/** The role rides the first delta of a stream, per the OpenAI shape. */
export type DeltaContent = {
  role?: string;
  content?: string;
  tool_calls?: DeltaToolCall[];
  grounding_metadata?: StructuredGrounding;
};

export type ChatCompletionChunk = {
  id: string;
  model: string;
  created: number;
  object: string;
  choices: Array<{ index: number; delta: DeltaContent; finish_reason: string | null }>;
  usage?: CompletionUsage;
  warnings?: Warning[];
};

export interface BuildChunkExtraOpts {
  warnings?: Warning[];
  usage?: CompletionUsage;
  choices?: ChatCompletionChunk["choices"];
}

export interface BuildChunkOptions extends BuildChunkExtraOpts {
  id?: string;
  model?: string;
  created?: number;
  delta?: DeltaContent;
  finishReason?: string | null;
}

export type OpenAIErrorBody = {
  message: string;
  type: string;
  code?: string;
  param: string | null;
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function detectStatus(err: unknown): number | null {
  const rec = asRecord(err);
  if (!rec) return null;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
}

export function buildCompletionWithId(
  result: TurnResult,
  model: string,
  id: string,
  created: number,
  warnings?: Warning[],
): ChatCompletion {
  const completion: ChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.toolCalls.length > 0 ? result.content || null : result.content,
          ...(result.toolCalls.length > 0
            ? {
                tool_calls: result.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                  // Emitted only when present, so a response without a signature
                  // stays byte-identical (no extra JSON field).
                  ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
                })),
              }
            : {}),
          ...(result.groundingMetadata
            ? (() => {
                const structured = extractStructuredGrounding(result.groundingMetadata);
                return structured ? { grounding_metadata: structured } : {};
              })()
            : {}),
        },
        finish_reason: result.finishReason,
      },
    ],
  };
  if (result.usage !== null) completion.usage = result.usage;

  const allWarnings: Warning[] = [];
  if (result.warnings && result.warnings.length > 0) {
    allWarnings.push(...result.warnings);
  }
  if (warnings && warnings.length > 0) {
    for (const w of warnings) {
      if (!allWarnings.some((existing) => existing.field === w.field && existing.reason === w.reason)) {
        allWarnings.push(w);
      }
    }
  }
  if (allWarnings.length > 0) {
    completion.warnings = allWarnings;
  }

  return completion;
}

export function buildCompletion(
  result: TurnResult,
  model: string,
  warnings?: Warning[],
): ChatCompletion {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return buildCompletionWithId(result, model, id, created, warnings);
}

export function buildChunk(opts: BuildChunkOptions): ChatCompletionChunk;
export function buildChunk(
  id: string,
  model: string,
  created: number,
  delta: DeltaContent,
  finishReason: string | null,
  opts?: BuildChunkExtraOpts,
): ChatCompletionChunk;
export function buildChunk(
  idOrOpts: string | BuildChunkOptions,
  model?: string,
  created?: number,
  delta?: DeltaContent,
  finishReason?: string | null,
  opts?: BuildChunkExtraOpts,
): ChatCompletionChunk {
  if (typeof idOrOpts === "object" && idOrOpts !== null) {
    const chunkId = idOrOpts.id ?? `chatcmpl-${randomUUID()}`;
    const chunkModel = idOrOpts.model ?? "";
    const chunkCreated = idOrOpts.created ?? Math.floor(Date.now() / 1000);
    const chunkChoices =
      idOrOpts.choices !== undefined
        ? idOrOpts.choices
        : [{ index: 0, delta: idOrOpts.delta ?? {}, finish_reason: idOrOpts.finishReason ?? null }];

    const chunk: ChatCompletionChunk = {
      id: chunkId,
      model: chunkModel,
      created: chunkCreated,
      object: "chat.completion.chunk",
      choices: chunkChoices,
    };
    if (idOrOpts.usage !== undefined) {
      chunk.usage = idOrOpts.usage;
    }
    if (idOrOpts.warnings && idOrOpts.warnings.length > 0) {
      chunk.warnings = idOrOpts.warnings;
    }
    return chunk;
  }

  const chunkId = idOrOpts;
  const chunkModel = model ?? "";
  const chunkCreated = created ?? Math.floor(Date.now() / 1000);
  const chunkChoices =
    opts?.choices !== undefined
      ? opts.choices
      : [{ index: 0, delta: delta ?? {}, finish_reason: finishReason ?? null }];

  const chunk: ChatCompletionChunk = {
    id: chunkId,
    model: chunkModel,
    created: chunkCreated,
    object: "chat.completion.chunk",
    choices: chunkChoices,
  };
  if (opts?.usage !== undefined) {
    chunk.usage = opts.usage;
  }
  if (opts?.warnings && opts.warnings.length > 0) {
    chunk.warnings = opts.warnings;
  }
  return chunk;
}

export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function toOpenAIErrorBody(
  err: unknown,
  status = 500,
): { status: number; body: { error: OpenAIErrorBody } } {
  const message = err instanceof Error ? err.message : String(err);
  const detected = detectStatus(err);
  // Um 4xx do upstream pertence ao chamador (rate limit, requisicao rejeitada) e deve
  // sobreviver a traducao: o fallback descreve a falha do proprio wrapper (502 = transporte
  // ou inicializacao), entao deixa-lo vencer achatava um 429 em 502. Um 5xx do upstream
  // mantem o fallback, que e como o wrapper reporta um upstream indisponivel.
  // Um fallback fora de [100,599] nunca chega ao reply: o Fastify o rejeita
  // (FST_ERR_BAD_STATUS_CODE, medido 2026-10-16) e o erro vira 500 no handler.
  const fallback = status >= 100 && status <= 599 ? status : 500;
  const finalStatus = detected !== null && detected >= 400 && detected < 500 ? detected : fallback;

  const error: OpenAIErrorBody =
    finalStatus === 400 || finalStatus === 422
      ? { message, type: "invalid_request_error", param: null }
      : finalStatus === 404
        ? { message, type: "invalid_request_error", code: "model_not_found", param: null }
        : finalStatus === 429
          ? { message, type: "rate_limit_error", code: "rate_limit_exceeded", param: null }
          : { message, type: "server_error", code: "antigravity_error", param: null };

  return { status: finalStatus, body: { error } };
}
