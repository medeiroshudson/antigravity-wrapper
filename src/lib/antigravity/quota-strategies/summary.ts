import { retrieveUserQuotaSummary } from "../quota.js";
import type {
  QuotaFetchContext,
  QuotaFetchResult,
  QuotaFetchStrategy,
  QuotaStrategyName,
} from "./types.js";

/** The authoritative reading: the group/bucket quota the Antigravity app displays. */
export class SummaryQuotaStrategy implements QuotaFetchStrategy {
  readonly name: QuotaStrategyName = "summary";

  async fetch(ctx: QuotaFetchContext): Promise<QuotaFetchResult> {
    const result = await retrieveUserQuotaSummary({
      accessToken: ctx.accessToken,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
    });
    return { rows: result.rows, failure: result.failure };
  }
}
