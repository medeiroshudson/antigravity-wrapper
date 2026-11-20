import { PACING_TOLERANCE } from "../pacing.js";
import { byLastUseThenId } from "./comparators.js";
import type { AccountSnapshot } from "../store.js";
import type { EligibleCandidate, LoadBalanceStrategy, SelectionContext } from "./types.js";

/**
 * Emits the top `PACING_TOLERANCE` band by least recent use, then the rest by pace score
 * descending (spec D2's tolerance band), same as the selector.
 */
function orderByPace(candidates: readonly EligibleCandidate[]): EligibleCandidate[] {
  if (candidates.length === 0) return [];
  const best = Math.max(...candidates.map((candidate) => candidate.score ?? Number.NEGATIVE_INFINITY));
  const bandLimit = best - PACING_TOLERANCE;
  const band: EligibleCandidate[] = [];
  const outside: EligibleCandidate[] = [];
  for (const candidate of candidates) {
    if ((candidate.score ?? Number.NEGATIVE_INFINITY) >= bandLimit) band.push(candidate);
    else outside.push(candidate);
  }
  band.sort(byLastUseThenId);
  outside.sort((left, right) => {
    const byScore = (right.score ?? 0) - (left.score ?? 0);
    return byScore !== 0 ? byScore : byLastUseThenId(left, right);
  });
  return [...band, ...outside];
}

/** The selector's tiering and tolerance band, without eligibility checks or priority. */
export class PaceDeficitStrategy implements LoadBalanceStrategy {
  readonly name = "pace-deficit";

  rank(candidates: readonly EligibleCandidate[], _ctx: SelectionContext): AccountSnapshot[] {
    const scoredPositive = candidates.filter(
      (candidate) => candidate.quota !== null && candidate.quota > 0 && candidate.score !== null,
    );
    const unscoredPositive = candidates.filter(
      (candidate) => candidate.quota !== null && candidate.quota > 0 && candidate.score === null,
    );
    const unknown = candidates.filter((candidate) => candidate.quota === null);
    const expiredZero = candidates.filter((candidate) => candidate.quota !== null && candidate.quota <= 0);
    unscoredPositive.sort((left, right) => {
      const byQuota = (right.quota ?? 0) - (left.quota ?? 0);
      return byQuota !== 0 ? byQuota : byLastUseThenId(left, right);
    });
    unknown.sort(byLastUseThenId);
    expiredZero.sort(byLastUseThenId);
    return [...orderByPace(scoredPositive), ...unscoredPositive, ...unknown, ...expiredZero].map(
      (candidate) => candidate.account,
    );
  }
}
