import type { AccountSnapshot } from "./store.js";

export function summarizeQuota(account: AccountSnapshot, runtimeModel: string): number | null {
  const relevant = account.quota.filter((row) => row.modelId === runtimeModel);
  if (relevant.length === 0) return null;
  return relevant.reduce((min, row) => Math.min(min, row.remainingFraction), 1);
}

/**
 * Orders the candidates for a request. Pure function: no network, no SQLite.
 *
 * Rules (spec §9.2):
 *  1. only enabled, non-invalid accounts; an expired cooldown becomes valid again
 *     — a cooldown without `cooldownUntil` is treated as already over (eligible),
 *       since discarding it would silently and permanently lose the account
 *  2. explicit priority comes before quota
 *  3. known quota before unknown quota — unknown is NEUTRAL,
 *     neither zero (would exclude a new account) nor full (would always be preferred)
 *  4. within the group, decreasing quota and, on a tie, older use
 */
export function order(
  snapshot: readonly AccountSnapshot[],
  runtimeModel: string,
  now: number = Date.now(),
): AccountSnapshot[] {
  const eligible = snapshot.filter((account) => {
    if (!account.enabled) return false;
    if (account.status === "invalid") return false;
    if (account.status === "cooldown") {
      // With no expiry recorded, the cooldown is considered over: keeping the
      // account ineligible forever would be a silent, permanent loss.
      return account.cooldownUntil === null || account.cooldownUntil <= now;
    }
    return true;
  });

  const scored = eligible.map((account) => ({ account, quota: summarizeQuota(account, runtimeModel) }));

  scored.sort((left, right) => {
    if (left.account.priority !== right.account.priority) {
      return right.account.priority - left.account.priority;
    }
    const leftKnown = left.quota !== null;
    const rightKnown = right.quota !== null;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && left.quota !== right.quota) {
      return (right.quota ?? 0) - (left.quota ?? 0);
    }
    return (left.account.lastUsedAt ?? 0) - (right.account.lastUsedAt ?? 0);
  });

  return scored.map((entry) => entry.account);
}
