import { getMaxFailoverAttempts } from "../../config/index.js";
import { getMaxOutputTokens, getThinkingConfig, type ReasoningEffort } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import type { AccountService } from "../accounts/service.js";
import { buildEnvelope, newRequestIdentity, type GeminiContent } from "../antigravity/envelope.js";
import { UpstreamError } from "../antigravity/errors.js";
import { readSse, streamGenerate } from "../antigravity/rpc.js";
import type { TurnResult } from "../openai-format/index.js";
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
  constructor(readonly failures: Array<{ accountId: string; kind: string; message: string }>) {
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
}

/**
 * Errors left over AFTER the first streamed content: failover is over (spec
 * §6.3), so they are not an account failure and `run` propagates them to the
 * caller instead of trying the next account.
 */
const fatalAfterContent = new WeakSet<object>();

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
  constructor(private readonly deps: TurnDeps) {}

  async run(
    input: TurnInput,
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
  ): Promise<TurnOutcome> {
    const candidates = await this.deps.accounts.orderFor(input.runtimeModel);
    const limit = getMaxFailoverAttempts(this.deps.env);
    const failures: Array<{ accountId: string; kind: string; message: string }> = [];
    const tried = new Set<string>();

    for (const candidate of candidates.slice(0, limit)) {
      if (tried.has(candidate.id)) continue;
      tried.add(candidate.id);

      try {
        const fresh = await this.deps.accounts.ensureFresh(candidate);
        if (!fresh.projectId) throw new UpstreamError("server_error", 0, t("chat.accountWithoutProjectId"));
        this.deps.accounts.markUsed(candidate.id);
        const result = await this.runOnce(input, fresh.accessToken ?? "", fresh.projectId, opts);
        return { result, accountId: candidate.id };
      } catch (error) {
        if (error instanceof UpstreamError) {
          // A client error is not fixed by switching accounts, and an error that
          // arrived after the first content can no longer switch accounts: propagate.
          if (error.kind === "client_error" || fatalAfterContent.has(error)) throw error;
          this.deps.accounts.applyFailure(candidate.id, error);
          // After a 429 that account's snapshot is stale: refresh the quota
          // best-effort (spec §9.3). Without blocking failover.
          if (error.status === 429) {
            void this.deps.accounts.refreshQuota(candidate.id).catch(() => undefined);
          }
          failures.push({ accountId: candidate.id, kind: error.kind, message: error.message });
          continue;
        }
        throw error;
      }
    }

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
    });

    let content = "";
    let finishReason = "STOP";
    let usage: TurnResult["usage"] = null;
    let sawFinish = false;
    const toolParts: Array<Record<string, unknown>> = [];

    try {
      for await (const chunk of readSse(response, { signal: opts.signal })) {
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

      if (!sawFinish) {
        throw new UpstreamError("server_error", 0, t("chat.streamWithoutFinishReason"));
      }
    } catch (error) {
      // Fatal after the first content only when there is a stream consumer:
      // in `stream:false` nothing reached the client until the final JSON, so a
      // recoverable error mid-generation can still fall through to the next
      // account (spec §6.3).
      if (opts.onDelta && content.length > 0) fatalAfterContent.add(error as object);
      throw error;
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
