import { endpointCandidates, getUpstreamTimeoutMs, getUserAgent } from "../../config/index.js";
import type { QuotaSnapshot } from "../accounts/store.js";

interface ModelsPayload {
  models?: Record<string, { isInternal?: unknown; quotaInfo?: { remainingFraction?: unknown; resetTime?: unknown } }>;
}

/**
 * Reads `fetchAvailableModels` and returns one quota row per usable model.
 * Best-effort: a network failure returns an empty list instead of failing the
 * refresh — an account without known quota stays eligible (spec §9.2).
 */
export async function fetchAvailableModels(input: {
  accessToken: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<Array<Omit<QuotaSnapshot, "accountId">>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getUserAgent(input.env),
  };

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
      const now = Date.now();
      const rows: Array<Omit<QuotaSnapshot, "accountId">> = [];
      for (const [modelId, info] of Object.entries(data.models ?? {})) {
        if (!info || info.isInternal) continue;
        if (/^(chat_|tab_)/i.test(modelId)) continue;
        const remaining = info.quotaInfo?.remainingFraction;
        if (typeof remaining !== "number") continue;
        const resetRaw = info.quotaInfo?.resetTime;
        const resetAt = typeof resetRaw === "string" ? Date.parse(resetRaw) : NaN;
        rows.push({
          modelId,
          window: "model",
          remainingFraction: Math.max(0, Math.min(1, remaining)),
          resetAt: Number.isFinite(resetAt) ? resetAt : null,
          fetchedAt: now,
        });
      }
      return rows;
    } catch {
      // Failure swallowed on purpose: fetchAvailableModels is best-effort. An account
      // without known quota must stay eligible (spec §9.2), so we do not propagate
      // the error. This module has no log sink.
    }
  }
  return [];
}
