import { byLastUseThenId } from "./comparators.js";
import type { AccountSnapshot } from "../store.js";
import type { EligibleCandidate, LoadBalanceStrategy, SelectionContext } from "./types.js";

function inFlight(candidate: EligibleCandidate, ctx: SelectionContext): number {
  return ctx.inFlightByAccount?.get(candidate.account.id) ?? 0;
}

/** Fewest in-flight requests first, then pace score, then least recent use. */
export class LeastBusyStrategy implements LoadBalanceStrategy {
  readonly name = "least-busy";

  rank(candidates: readonly EligibleCandidate[], ctx: SelectionContext): AccountSnapshot[] {
    return [...candidates]
      .sort((left, right) => {
        const byLoad = inFlight(left, ctx) - inFlight(right, ctx);
        if (byLoad !== 0) return byLoad;
        if (left.score !== null && right.score !== null && Number.isFinite(left.score) && Number.isFinite(right.score)) {
          const byScore = right.score - left.score;
          if (byScore !== 0) return byScore;
        }
        return byLastUseThenId(left, right);
      })
      .map((candidate) => candidate.account);
  }
}
