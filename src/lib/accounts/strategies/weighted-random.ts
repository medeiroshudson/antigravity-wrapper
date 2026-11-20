import type { AccountSnapshot } from "../store.js";
import type { EligibleCandidate, LoadBalanceStrategy, SelectionContext } from "./types.js";

/** A zero or unknown quota still gets a small chance; it just loses to real remaining quota. */
function weightOf(candidate: EligibleCandidate): number {
  return candidate.quota !== null && candidate.quota > 0 ? candidate.quota : 0.1;
}

/** Weighted sampling without replacement: every candidate is returned exactly once. */
export class WeightedRandomStrategy implements LoadBalanceStrategy {
  readonly name = "weighted-random";

  constructor(private readonly random: () => number = Math.random) {}

  rank(candidates: readonly EligibleCandidate[], _ctx: SelectionContext): AccountSnapshot[] {
    const remaining = [...candidates];
    const ordered: AccountSnapshot[] = [];
    while (remaining.length > 0) {
      const weights = remaining.map(weightOf);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let target = this.random() * total;
      let index = weights.length - 1;
      for (let i = 0; i < weights.length; i += 1) {
        target -= weights[i] ?? 0;
        if (target < 0) {
          index = i;
          break;
        }
      }
      ordered.push(remaining[index]!.account);
      remaining.splice(index, 1);
    }
    return ordered;
  }
}
