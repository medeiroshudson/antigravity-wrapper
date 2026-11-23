import type { QuotaBucket } from "../../accounts/store.js";
import type { QuotaSummaryFailureReason } from "../quota.js";

export type QuotaStrategyName = "auto" | "summary" | "catalog";

export interface QuotaFetchContext {
  accessToken: string;
  projectId: string;
  isFreeTier?: boolean;
  /** The catalog's `quotaInfo` rows, when the caller already read them. */
  catalogQuota?: Array<Omit<QuotaBucket, "accountId">>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface QuotaFetchResult {
  rows: Array<Omit<QuotaBucket, "accountId">>;
  failure: { reason: QuotaSummaryFailureReason; detail: string } | null;
}

export interface QuotaFetchStrategy {
  readonly name: QuotaStrategyName;
  fetch(ctx: QuotaFetchContext): Promise<QuotaFetchResult>;
}
