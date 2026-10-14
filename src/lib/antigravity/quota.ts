import { endpointCandidates, getUpstreamTimeoutMs, getUserAgent, redact } from "../../config/index.js";
import type { CatalogEntry } from "../../config/models.js";
import type { QuotaBucket } from "../accounts/store.js";

interface ModelsPayload {
  models?: Record<
    string,
    {
      isInternal?: unknown;
      displayName?: unknown;
      maxTokens?: unknown;
      maxOutputTokens?: unknown;
      supportsThinking?: unknown;
      thinkingBudget?: unknown;
    }
  >;
}

interface SummaryPayload {
  groups?: Array<{
    displayName?: unknown;
    description?: unknown;
    buckets?: Array<{
      bucketId?: unknown;
      displayName?: unknown;
      window?: unknown;
      description?: unknown;
      resetTime?: unknown;
      remainingFraction?: unknown;
    }>;
  }>;
}

export type QuotaSummaryFailureReason = "subscription_required" | "unavailable";

export interface QuotaSummaryResult {
  rows: Array<Omit<QuotaBucket, "accountId">>;
  /** `null` when the summary was read, or when nothing answered at all (spec §11). */
  failure: { reason: QuotaSummaryFailureReason; detail: string } | null;
}

function antigravityHeaders(accessToken: string, env?: NodeJS.ProcessEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    // Required: without the first-party fingerprint the backend answers 403.
    "User-Agent": getUserAgent(env),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageOf(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : null;
}

/**
 * Reads the error envelope. The subscription case is identified by
 * `details[].reason === "SUBSCRIPTION_REQUIRED"` and never by the message text: the
 * missing-fingerprint 403 carries byte-identical text, so matching on it would report
 * a wrapper misconfiguration as a subscription problem (spec §3.4).
 */
function classifyFailure(
  status: number,
  body: unknown,
  raw: string,
): { reason: QuotaSummaryFailureReason; detail: string } {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  const subscriptionRequired =
    Array.isArray(details) &&
    details.some(
      (detail) => (detail as { reason?: unknown } | null)?.reason === "SUBSCRIPTION_REQUIRED",
    );
  const detail = redact(messageOf(body) ?? raw).slice(0, 200);
  return { reason: subscriptionRequired ? "subscription_required" : "unavailable", detail };
}

function flatten(payload: SummaryPayload, now: number): Array<Omit<QuotaBucket, "accountId">> {
  const rows: Array<Omit<QuotaBucket, "accountId">> = [];
  for (const group of payload.groups ?? []) {
    const groupName = typeof group?.displayName === "string" ? group.displayName : null;
    const groupDescription = typeof group?.description === "string" ? group.description : null;
    for (const bucket of group?.buckets ?? []) {
      const bucketId = typeof bucket?.bucketId === "string" ? bucket.bucketId : null;
      const remaining = bucket?.remainingFraction;
      if (!bucketId || typeof remaining !== "number") continue;
      const resetAt =
        typeof bucket?.resetTime === "string" ? Date.parse(bucket.resetTime) : Number.NaN;
      rows.push({
        bucketId,
        window: typeof bucket?.window === "string" ? bucket.window : "",
        displayName: typeof bucket?.displayName === "string" ? bucket.displayName : null,
        groupName,
        groupDescription,
        bucketDescription: typeof bucket?.description === "string" ? bucket.description : null,
        remainingFraction: Math.max(0, Math.min(1, remaining)),
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
        fetchedAt: now,
      });
    }
  }
  return rows;
}

/**
 * Reads the group/bucket quota the Antigravity app itself displays (spec §3.1).
 *
 * Best-effort: a read failure returns no rows and a `failure` describing why, and never
 * throws — an account without a known quota must stay eligible (spec §8). A `failure` of
 * `null` with no rows means nothing answered, so there is no reason to quote.
 */
export async function retrieveUserQuotaSummary(input: {
  accessToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<QuotaSummaryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = antigravityHeaders(input.accessToken, input.env);
  let failure: QuotaSummaryResult["failure"] = null;

  for (const endpoint of endpointCandidates(input.env)) {
    try {
      const response = await fetchImpl(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers,
        // The RPC takes no metadata: sending it is a 400 (spec §3.2).
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(getUpstreamTimeoutMs(input.env)),
      });

      const text = await response.text();
      const body = parseJson(text);

      if (!response.ok) {
        failure = classifyFailure(response.status, body, text);
        continue;
      }
      if (body === null) {
        failure = { reason: "unavailable", detail: `HTTP ${response.status}: body was not JSON` };
        continue;
      }
      return { rows: flatten(body as SummaryPayload, Date.now()), failure: null };
    } catch {
      // Transport failure: leave `failure` as it was. This module has no log sink, and
      // the caller distinguishes "an answer we can quote" from "no answer" by its absence.
    }
  }

  return { rows: [], failure };
}

/**
 * Reads the model catalog: the ids the account can serve, with the backend's own metadata.
 *
 * Every optional field becomes `null` when the backend omits it, and is never guessed: the
 * registry owns the fallbacks, and inventing a number here would hide a catalog change.
 * Best-effort — a failure returns `[]`, so the caller keeps whatever catalog it had.
 */
export async function fetchAvailableModels(input: {
  accessToken: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<CatalogEntry[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = antigravityHeaders(input.accessToken, input.env);

  for (const endpoint of endpointCandidates(input.env)) {
    try {
      const response = await fetchImpl(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project: input.projectId }),
        signal: AbortSignal.timeout(getUpstreamTimeoutMs(input.env)),
      });
      if (!response.ok) continue;

      const data = (await response.json()) as ModelsPayload;
      const entries: CatalogEntry[] = [];
      for (const [modelId, info] of Object.entries(data.models ?? {})) {
        if (!info || info.isInternal) continue;
        if (/^(chat_|tab_)/i.test(modelId)) continue;
        entries.push({
          id: modelId,
          displayName: typeof info.displayName === "string" ? info.displayName : null,
          maxTokens: typeof info.maxTokens === "number" ? info.maxTokens : null,
          maxOutputTokens: typeof info.maxOutputTokens === "number" ? info.maxOutputTokens : null,
          supportsThinking: info.supportsThinking === true,
          thinkingBudget: typeof info.thinkingBudget === "number" ? info.thinkingBudget : null,
        });
      }
      return entries;
    } catch {
      // Failure swallowed on purpose: the catalog read is best-effort and an account
      // without a fresh catalog must stay eligible (spec §8).
    }
  }
  return [];
}
