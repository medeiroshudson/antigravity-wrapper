import { fetchAvailableModelsWithQuota } from "../quota.js";
import type {
  QuotaFetchContext,
  QuotaFetchResult,
  QuotaFetchStrategy,
  QuotaStrategyName,
} from "./types.js";

/** The free-tier reading: `quotaInfo` collapsed to one bucket per family. */
export class CatalogQuotaStrategy implements QuotaFetchStrategy {
  readonly name: QuotaStrategyName = "catalog";

  async fetch(ctx: QuotaFetchContext): Promise<QuotaFetchResult> {
    // The caller already paid for the catalog read; do not fetch it twice.
    if (ctx.catalogQuota) return { rows: ctx.catalogQuota, failure: null };

    const result = await fetchAvailableModelsWithQuota({
      accessToken: ctx.accessToken,
      projectId: ctx.projectId,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
    });
    return { rows: result.quota, failure: null };
  }
}
