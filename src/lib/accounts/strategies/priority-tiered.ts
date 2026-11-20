import type { AccountSnapshot } from "../store.js";
import type { EligibleCandidate, LoadBalanceStrategy, SelectionContext } from "./types.js";

/** Makes explicit priority the outermost key; ties inside a level are the inner strategy's call. */
export class PriorityTieredStrategy implements LoadBalanceStrategy {
  readonly name: LoadBalanceStrategy["name"];

  constructor(private readonly inner: LoadBalanceStrategy) {
    this.name = inner.name;
  }

  rank(candidates: readonly EligibleCandidate[], ctx: SelectionContext): AccountSnapshot[] {
    const byPriority = new Map<number, EligibleCandidate[]>();
    for (const candidate of candidates) {
      const level = byPriority.get(candidate.account.priority);
      if (level) level.push(candidate);
      else byPriority.set(candidate.account.priority, [candidate]);
    }
    return [...byPriority.keys()]
      .sort((left, right) => right - left)
      .flatMap((priority) => this.inner.rank(byPriority.get(priority) ?? [], ctx));
  }
}
