import { CatalogQuotaStrategy } from "./catalog.js";
import { FallbackQuotaStrategy } from "./fallback.js";
import { SummaryQuotaStrategy } from "./summary.js";
import type { QuotaFetchStrategy, QuotaStrategyName } from "./types.js";

/** Builds a quota strategy by name; `auto` is the summary-then-catalog fallback. */
export function createQuotaStrategy(name: QuotaStrategyName = "auto"): QuotaFetchStrategy {
  switch (name) {
    case "summary":
      return new SummaryQuotaStrategy();
    case "catalog":
      return new CatalogQuotaStrategy();
    case "auto":
      return new FallbackQuotaStrategy();
  }
}
