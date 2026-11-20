import { byLastUseThenId } from "./comparators.js";
import type {
  EligibleCandidate,
  LoadBalanceStrategy,
  SelectionContext,
} from "./types.js";
import type { AccountSnapshot } from "../store.js";

/** Known positive quota first (largest remaining), then unknown, then expired zero. */
export class QuotaFirstStrategy implements LoadBalanceStrategy {
  readonly name = "quota-first";

  rank(candidates: readonly EligibleCandidate[], _ctx: SelectionContext): AccountSnapshot[] {
    const positive = candidates.filter((candidate) => candidate.quota !== null && candidate.quota > 0);
    const unknown = candidates.filter((candidate) => candidate.quota === null);
    const expiredZero = candidates.filter((candidate) => candidate.quota !== null && candidate.quota <= 0);
    positive.sort((left, right) => {
      const byQuota = (right.quota ?? 0) - (left.quota ?? 0);
      return byQuota !== 0 ? byQuota : byLastUseThenId(left, right);
    });
    unknown.sort(byLastUseThenId);
    expiredZero.sort(byLastUseThenId);
    return [...positive, ...unknown, ...expiredZero].map((candidate) => candidate.account);
  }
}
