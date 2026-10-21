import { getMaxFailoverAttempts, getTransientRetryBackoffMs } from "../../config/index.js";
import { getMaxOutputTokens, getThinkingConfig, type ReasoningEffort } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import type { AccountService } from "../accounts/service.js";
import { buildEnvelope, newRequestIdentity, type GeminiContent } from "../antigravity/envelope.js";
import { isDefinitive, ClientDisconnectedError, UpstreamError } from "../antigravity/errors.js";
import { readSse, streamGenerate } from "../antigravity/rpc.js";
import { noopLogger, type Logger } from "../logger.js";
import { formatCitationsFooter, type GroundingMetadata } from "./grounding.js";
import { normalizeToolCalls } from "./tools.js";
import { rememberSignature } from "./signatures.js";
import type { Warning } from "./diagnostics.js";

export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface TurnResult {
  content: string;
  finishReason: string;
  usage: TurnUsage | null;
  toolCalls: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }>;
  blockedReason?: string;
  warnings?: Warning[];
  groundingMetadata?: GroundingMetadata;
  reasoningContent?: string;
}

export interface TurnInput {
  runtimeModel: string;
  contents: GeminiContent[];
  systemInstruction: string;
  effort: ReasoningEffort;
  tools?: { functionDeclarations: unknown[] };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
  enableWebSearch?: boolean;
}

export interface TurnOutcome {
  result: TurnResult;
  accountId: string;
}

export class AllAccountsFailedError extends Error {
  override name = "AllAccountsFailedError";
  constructor(
    readonly failures: Array<{ accountId: string; kind: string; message: string; retryAfterMs?: number | null }>,
  ) {
    super(
      failures.length === 0
        ? t("account.noEligible")
        : t("account.allFailed", {
            failures: failures.map((f) => `${f.accountId}(${f.kind})`).join(", "),
          }),
    );
    Object.setPrototypeOf(this, AllAccountsFailedError.prototype);
  }
}

export interface TurnDeps {
  accounts: AccountService;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Errors left over AFTER the first streamed content: failover is over (spec
 * §6.3), so they are not an account failure and `run` propagates them to the
 * caller instead of trying the next account.
 */
const fatalAfterContent = new WeakSet<object>();

/** Extra tries on the same account after a transient throttle, before switching. */
const TRANSIENT_RETRIES = 1;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Maps the backend `finishReason` to the OpenAI vocabulary.
 * Unknown upstream reasons map to "stop" with a diagnostic warning.
 * `SAFETY`/`RECITATION` are content blocks: reporting them as `content_filter`.
 */
export function mapFinishReason(raw: string | undefined): { reason: string; warning?: Warning } {
  if (raw === "STOP") return { reason: "stop" };
  if (raw === "MAX_TOKENS") return { reason: "length" };
  if (raw === "SAFETY" || raw === "RECITATION") return { reason: "content_filter" };
  return {
    reason: "stop",
    warning: {
      field: "finish_reason",
      reason: t("warn.unknownFinishReason", { reason: raw ?? "undefined" }),
    },
  };
}

/**
 * Runs a turn against the pool. Failover exists only BEFORE the first byte:
 * once the text starts flowing there is no way to switch accounts, and the
 * failure becomes a visible error (spec §6.3).
 */
export class TurnRunner {
  private readonly logger: Logger;

  constructor(private readonly deps: TurnDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async run(
    input: TurnInput,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onReasoningDelta?: (text: string) => void } = {},
  ): Promise<TurnOutcome> {
    const candidates = await this.deps.accounts.orderFor(input.runtimeModel);
    const limit = getMaxFailoverAttempts(this.deps.env);
    const backoffMs = getTransientRetryBackoffMs(this.deps.env);
    const failures: Array<{ accountId: string; kind: string; message: string; retryAfterMs?: number | null }> = [];
    this.logger.debug(
      { runtimeModel: input.runtimeModel, candidates: candidates.map((c) => c.id), limit },
      "turn candidates",
    );
    // The first definitive error seen across the pool. A 404 is authoritative for an
    // endpoint but not for an account (see the catch below), so it is remembered and only
    // rethrown once every account has failed with the same kind.
    let definitiveError: UpstreamError | null = null;
    const tried = new Set<string>();

    for (const candidate of candidates.slice(0, limit)) {
      if (tried.has(candidate.id)) continue;
      tried.add(candidate.id);

      // A transient throttle earns the account one more try before the request
      // moves on: the account is healthy and its quota intact, so switching away
      // would spend the next account on a problem the first one does not have.
      for (let attempt = 0; ; attempt += 1) {
        // A client that already left cannot be served: check before every attempt, or
        // the transient backoff and the account switch would spend full upstream turns
        // on a dead request.
        if (opts.signal?.aborted) throw new ClientDisconnectedError();
        try {
          this.logger.debug({ accountId: candidate.id, attempt }, "account attempt");
          const fresh = await this.deps.accounts.ensureFresh(candidate);
          if (!fresh.projectId) {
            throw new UpstreamError("server_error", 0, t("chat.accountWithoutProjectId"));
          }
          this.deps.accounts.markUsed(candidate.id);
          const result = await this.runOnce(input, fresh.accessToken ?? "", fresh.projectId, opts);
          return { result, accountId: candidate.id };
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;

          // After the first content the answer is on the wire, so switching accounts is
          // over: that failure propagates as itself (spec §6.3).
          if (fatalAfterContent.has(error)) throw error;

          // Account vs endpoint asymmetry. For ENDPOINTS a 404 is authoritative -- a single
          // backend, the primary channel is the authority, and `rpc.ts` already stops on it.
          // For ACCOUNTS it is not: each account has its own catalog, so a model this one
          // lacks may be present on the next. A definitive failure therefore fails over like
          // any other account failure -- recorded, but with no state change -- and is
          // rethrown below only once every account agrees (spec D10, §6.2).
          if (isDefinitive(error.kind)) {
            definitiveError ??= error;
            this.logger.warn(
              { accountId: candidate.id, kind: error.kind, status: error.status, definitive: true },
              "account failure",
            );
            failures.push({ accountId: candidate.id, kind: error.kind, message: error.message });
            break;
          }

          if (error.kind === "transient_rate_limit" && attempt < TRANSIENT_RETRIES) {
            this.logger.debug(
              { accountId: candidate.id, kind: error.kind, backoffMs },
              "transient retry",
            );
            if (backoffMs > 0) await sleep(backoffMs);
            continue;
          }

          this.deps.accounts.applyFailure(candidate.id, error);
          this.logger.warn(
            {
              accountId: candidate.id,
              kind: error.kind,
              status: error.status,
              // client_error, model_not_found, server_error and license change no state,
              // so name the action instead of the (misleadingly empty) cooldown window.
              action:
                error.kind === "quota"
                  ? "cooldown"
                  : error.kind === "auth" || error.kind === "validation_required"
                    ? "invalid"
                    : "none",
            },
            "account failure",
          );
          // After a 429 that account's snapshot is stale: refresh the quota
          // best-effort (spec §9.3). Without blocking failover.
          if (error.status === 429) {
            void this.deps.accounts.refreshQuota(candidate.id).catch(() => undefined);
          }
          failures.push({
            accountId: candidate.id,
            kind: error.kind,
            message: error.message,
            retryAfterMs: error.retryAfterMs,
          });
          break;
        }
      }
    }

    // A pool failure is only right when the accounts disagree. When every account rejected
    // the request with the same definitive error -- a model absent from all of them -- that
    // error is the answer: one clean 404 naming the model, not a pool failure that hides it
    // (spec D10).
    const definitive = definitiveError;
    if (definitive && failures.every((failure) => failure.kind === definitive.kind)) {
      this.logger.warn(
        { runtimeModel: input.runtimeModel, kind: definitive.kind, status: definitive.status },
        "turn rejected",
      );
      throw definitive;
    }

    this.logger.warn(
      {
        runtimeModel: input.runtimeModel,
        failures: failures.map((f) => ({ accountId: f.accountId, kind: f.kind })),
      },
      "all accounts failed",
    );
    throw new AllAccountsFailedError(failures);
  }

  private async runOnce(
    input: TurnInput,
    accessToken: string,
    projectId: string,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void; onReasoningDelta?: (text: string) => void },
  ): Promise<TurnResult> {
    const identity = newRequestIdentity(input.runtimeModel);
    const maxOutputTokens = getMaxOutputTokens(input.runtimeModel);
    const envelope = buildEnvelope({
      projectId,
      runtimeModel: input.runtimeModel,
      contents: input.contents,
      systemInstruction: input.systemInstruction,
      thinking: getThinkingConfig(input.runtimeModel, input.effort),
      maxOutputTokens: Math.min(input.maxTokens ?? maxOutputTokens, maxOutputTokens),
      tools: input.tools ? [input.tools] : undefined,
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
      temperature: input.temperature,
      topP: input.topP,
      topK: input.topK,
      stopSequences: input.stopSequences,
      responseMimeType: input.responseMimeType,
      responseSchema: input.responseSchema,
      enableWebSearch: input.enableWebSearch,
    });

    const response = await streamGenerate(accessToken, envelope, {
      signal: opts.signal,
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
      logger: this.logger,
    });

    let content = "";
    let reasoningContent = "";
    let rawFinishReason: string | undefined;
    let blockedReason: string | undefined;
    let usage: TurnResult["usage"] = null;
    let sawFinish = false;
    let latestGrounding: GroundingMetadata | undefined;
    const warnings: Warning[] = [];
    const toolParts: Array<Record<string, unknown>> = [];

    try {
      for await (const chunk of readSse(response, { signal: opts.signal, env: this.deps.env, logger: this.logger })) {
        const candidate = chunk.response?.candidates?.[0];
        const chunkBlocked =
          candidate?.promptFeedback?.blockReason ?? chunk.response?.promptFeedback?.blockReason;
        if (chunkBlocked && !blockedReason) {
          blockedReason = chunkBlocked;
        }

        const chunkGrounding = (candidate?.groundingMetadata ??
          chunk.response?.groundingMetadata) as GroundingMetadata | undefined;
        if (chunkGrounding) {
          latestGrounding = chunkGrounding;
        }

        for (const part of candidate?.content?.parts ?? []) {
          const text = part.text;
          if (typeof text === "string" && text.length > 0) {
            if (part.thought === true) {
              reasoningContent += text;
              opts.onReasoningDelta?.(text);
            } else {
              content += text;
              opts.onDelta?.(text);
            }
          }
          if (part.functionCall) toolParts.push(part);
        }
        if (candidate?.finishReason) {
          sawFinish = true;
          rawFinishReason = candidate.finishReason;
        }
        const meta = chunk.response?.usageMetadata;
        if (meta) {
          const prompt = meta.promptTokenCount ?? 0;
          const cacheRead = meta.cachedContentTokenCount ?? 0;
          const thoughts = meta.thoughtsTokenCount ?? 0;
          usage = {
            prompt_tokens: prompt,
            completion_tokens: (meta.candidatesTokenCount ?? 0) + thoughts,
            total_tokens: meta.totalTokenCount ?? 0,
            prompt_tokens_details: {
              cached_tokens: cacheRead,
            },
            completion_tokens_details: {
              reasoning_tokens: thoughts,
            },
          };
        }
      }

      // A response the backend's filters blocked arrives as content followed by a
      // clean end of body with no finishReason (measured). Content plus a clean end
      // is therefore the answer, not a broken stream; only a stream that produced
      // nothing at all is a failure. The cost of the trade-off is that a body
      // truncated exactly at a chunk boundary reads as complete — which still hands
      // the caller the text that arrived, instead of a 503 that discards it.
      if (!blockedReason && !sawFinish && content.length === 0 && reasoningContent.length === 0 && toolParts.length === 0) {
        throw new UpstreamError("server_error", 0, t("chat.streamWithoutFinishReason"));
      }
    } catch (error) {
      // The client hung up: the caller's verdict is the answer, not a failure to wrap
      // or fail over (measured: the 2nd account was started on a dead request).
      if (error instanceof ClientDisconnectedError) throw error;
      // A dropped connection or a stall surfaces as a plain Error from the reader.
      // Classify it here so the runner can act on it: in `stream:false` nothing has
      // reached the client yet, so there is still an account to fail over to.
      const failure =
        error instanceof UpstreamError
          ? error
          : new UpstreamError(
              "server_error",
              0,
              error instanceof Error ? error.message : String(error),
            );
      // Fatal after the first content only when there is a stream consumer:
      // in `stream:false` nothing reached the client until the final JSON, so a
      // recoverable error mid-generation can still fall through to the next
      // account (spec §6.3).
      if ((opts.onDelta || opts.onReasoningDelta) && (content.length > 0 || reasoningContent.length > 0)) {
        fatalAfterContent.add(failure);
      }
      throw failure;
    }

    if (!blockedReason) {
      const citationsFooter = formatCitationsFooter(latestGrounding);
      if (citationsFooter) {
        content += citationsFooter;
        opts.onDelta?.(citationsFooter);
      }
    }

    if (blockedReason) {
      warnings.push({
        field: "promptFeedback",
        reason: t("warn.promptBlocked", { reason: blockedReason }),
      });
      return {
        content: "",
        finishReason: "content_filter",
        usage,
        toolCalls: [],
        blockedReason,
        warnings,
      };
    }

    // `normalizeToolCalls` returns the nested OpenAI shape (function.{name,arguments});
    // `TurnResult` expects the flattened shape `buildCompletion` consumes, preserving
    // the `thoughtSignature` for multi-turn continuity (spec §15).
    const toolCalls = normalizeToolCalls(toolParts).map((call) => ({
      id: call.id ?? "",
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
    }));
    // Remember what the upstream signed before the client can drop it: the next turn's
    // history must carry these signatures again (see signatures.ts).
    for (const call of toolCalls) {
      if (call.id && call.thoughtSignature) rememberSignature(call.id, call.thoughtSignature);
    }

    let finishReason: string;
    if (rawFinishReason === "SAFETY" || rawFinishReason === "RECITATION") {
      finishReason = "content_filter";
    } else if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    } else {
      const mapped = mapFinishReason(rawFinishReason);
      finishReason = mapped.reason;
      if (mapped.warning) {
        warnings.push(mapped.warning);
      }
    }

    return {
      content,
      finishReason,
      usage,
      toolCalls,
      ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(latestGrounding ? { groundingMetadata: latestGrounding } : {}),
    };
  }
}
