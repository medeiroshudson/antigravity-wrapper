import type { AccountSnapshot } from "../store.js";
import type { EligibleCandidate, LoadBalanceStrategy, SelectionContext } from "./types.js";

/**
 * Rotation cursor per model family. Keyed by the bucket prefix so a Gemini burst does not
 * skip the next Claude turn; `*` stands for an unmeasured family.
 */
export class RoundRobinStrategy implements LoadBalanceStrategy {
  readonly name = "round-robin";

  private readonly cursors = new Map<string, number>();

  rank(candidates: readonly EligibleCandidate[], ctx: SelectionContext): AccountSnapshot[] {
    if (candidates.length === 0) return [];
    const key = ctx.bucketIdPrefix ?? "*";
    const sorted = [...candidates].sort((left, right) => {
      if (left.account.id === right.account.id) return 0;
      return left.account.id < right.account.id ? -1 : 1;
    });
    const start = ((this.cursors.get(key) ?? 0) % sorted.length + sorted.length) % sorted.length;
    this.cursors.set(key, start + 1);
    return [...sorted.slice(start), ...sorted.slice(0, start)].map((candidate) => candidate.account);
  }
}
