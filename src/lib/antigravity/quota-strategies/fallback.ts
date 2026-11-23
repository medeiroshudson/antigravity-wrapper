import { CatalogQuotaStrategy } from "./catalog.js";
import { SummaryQuotaStrategy } from "./summary.js";
import type {
  QuotaFetchContext,
  QuotaFetchResult,
  QuotaFetchStrategy,
  QuotaStrategyName,
} from "./types.js";

/**
 * Tries each strategy in order and keeps the first reading with rows.
 *
 * A known free-tier account is denied by the summary RPC (403 SUBSCRIPTION_REQUIRED),
 * so that call is skipped entirely instead of being spent on a guaranteed refusal.
 */
export class FallbackQuotaStrategy implements QuotaFetchStrategy {
  readonly name: QuotaStrategyName = "auto";

  constructor(
    private readonly strategies: readonly QuotaFetchStrategy[] = [
      new SummaryQuotaStrategy(),
      new CatalogQuotaStrategy(),
    ],
  ) {}

  async fetch(ctx: QuotaFetchContext): Promise<QuotaFetchResult> {
    const strategies =
      ctx.isFreeTier === true
        ? this.strategies.filter((strategy) => strategy.name !== "summary")
        : this.strategies;

    let failure: QuotaFetchResult["failure"] = null;
    for (const strategy of strategies) {
      const result = await strategy.fetch(ctx);
      if (result.rows.length > 0) return { rows: result.rows, failure: null };
      if (result.failure !== null) failure = result.failure;
    }
    return { rows: [], failure };
  }
}
