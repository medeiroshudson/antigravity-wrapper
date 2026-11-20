import type { EligibleCandidate } from "./types.js";

/** Oldest use first, an account never used counting as 0; ties break by id so order is stable. */
export function byLastUseThenId(left: EligibleCandidate, right: EligibleCandidate): number {
  const byUse = (left.account.lastUsedAt ?? 0) - (right.account.lastUsedAt ?? 0);
  if (byUse !== 0) return byUse;
  if (left.account.id === right.account.id) return 0;
  return left.account.id < right.account.id ? -1 : 1;
}
