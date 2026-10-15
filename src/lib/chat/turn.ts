import { getMaxFailoverAttempts, getTransientRetryBackoffMs } from "../../config/index.js";
import { getMaxOutputTokens, getThinkingConfig, type ReasoningEffort } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import type { AccountService } from "../accounts/service.js";
import { buildEnvelope, newRequestIdentity, type GeminiContent } from "../antigravity/envelope.js";
import { isDefinitive, UpstreamError } from "../antigravity/errors.js";
import { readSse, streamGenerate } from "../antigravity/rpc.js";
import type { TurnResult } from "../openai-format/index.js";
import { noopLogger, type Logger } from "../logger.js";
import { normalizeToolCalls } from "./tools.js";

export interface TurnInput {
  runtimeModel: string;
  contents: GeminiContent[];
  systemInstruction: string;
  effort: ReasoningEffort;
  tools?: { functionDeclarations: unknown[] };
  maxTokens?: number;
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
 * `SAFETY`/`RECITATION` are content blocks, not truncations: reporting them as
 * `length` would make the client try to continue a censored response.
 */
function mapFinishReason(reason: string): string {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return "length";
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
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
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
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
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
    });

    const response = await streamGenerate(accessToken, envelope, {
      signal: opts.signal,
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
      logger: this.logger,
    });

    let content = "";
    let finishReason = "STOP";
    let usage: TurnResult["usage"] = null;
    let sawFinish = false;
    const toolParts: Array<Record<string, unknown>> = [];

    try {
      for await (const chunk of readSse(response, { signal: opts.signal, env: this.deps.env, logger: this.logger })) {
        const candidate = chunk.response?.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          const text = part.text;
          if (typeof text === "string" && text.length > 0 && part.thought !== true) {
            content += text;
            opts.onDelta?.(text);
          }
          if (part.functionCall) toolParts.push(part);
        }
        if (candidate?.finishReason) {
          sawFinish = true;
          finishReason = candidate.finishReason;
        }
        const meta = chunk.response?.usageMetadata;
        if (meta) {
          const prompt = meta.promptTokenCount ?? 0;
          const cacheRead = meta.cachedContentTokenCount ?? 0;
          const thoughts = meta.thoughtsTokenCount ?? 0;
          usage = {
            prompt_tokens: prompt - cacheRead,
            completion_tokens: (meta.candidatesTokenCount ?? 0) + thoughts,
            total_tokens: meta.totalTokenCount ?? 0,
          };
        }
      }

      // A response the backend's filters blocked arrives as content followed by a
      // clean end of body with no finishReason (measured). Content plus a clean end
      // is therefore the answer, not a broken stream; only a stream that produced
      // nothing at all is a failure. The cost of the trade-off is that a body
      // truncated exactly at a chunk boundary reads as complete — which still hands
      // the caller the text that arrived, instead of a 503 that discards it.
      if (!sawFinish && content.length === 0 && toolParts.length === 0) {
        throw new UpstreamError("server_error", 0, t("chat.streamWithoutFinishReason"));
      }
    } catch (error) {
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
      if (opts.onDelta && content.length > 0) fatalAfterContent.add(failure);
      throw failure;
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

    return {
      content,
      finishReason: toolCalls.length > 0 ? "tool_calls" : mapFinishReason(finishReason),
      usage,
      toolCalls,
    };
  }
}
