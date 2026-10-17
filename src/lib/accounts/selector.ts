import type { AccountSnapshot } from "./store.js";

/**
 * The bucket-id prefix of the group a runtime model belongs to (spec §8): the backend
 * splits quota into "Gemini Models" (`gemini-*`) and "Claude and GPT models" (`3p-*`).
 * Returns `null` for a family with no known group, which scores as unknown quota.
 */
function groupPrefix(runtimeModel: string): string | null {
  if (/^gemini-/i.test(runtimeModel)) return "gemini";
  // `gpt-` and not `gpt-oss-`: the backend's own group is "Claude and GPT models", so the
  // whole OpenAI family belongs to `3p-*`. A narrower match would rank a future GPT model
  // as unknown quota.
  if (/^(claude-|gpt-)/i.test(runtimeModel)) return "3p";
  return null;
}

/**
 * Scores an account for a requested model: the lowest remaining fraction across the
 * requested model's group. `null` means unknown — a model whose family has no group, or
 * a group with no buckets, which is what a free-tier account reports (spec §3.5).
 *
 * Unknown is deliberately not 0 (which would exclude the account) nor 1 (which would
 * always prefer it).
 */
export function summarizeQuota(account: AccountSnapshot, runtimeModel: string): number | null {
  const prefix = groupPrefix(runtimeModel);
  if (prefix === null) return null;
  const bucketPrefix = `${prefix}-`;
  const relevant = account.quota.filter((row) => row.bucketId.startsWith(bucketPrefix));
  if (relevant.length === 0) return null;
  return relevant.reduce((lowest, row) => Math.min(lowest, row.remainingFraction), 1);
}

function hasExpiredZeroQuota(account: AccountSnapshot, runtimeModel: string, now: number): boolean {
  const prefix = groupPrefix(runtimeModel);
  if (!prefix) return false;
  const bucketPrefix = `${prefix}-`;
  const relevant = account.quota.filter((row) => row.bucketId.startsWith(bucketPrefix));
  if (relevant.length === 0) return false;
  const zeroBuckets = relevant.filter((row) => row.remainingFraction === 0);
  if (zeroBuckets.length === 0) return false;
  // If zero quota, only eligible if all binding zero buckets have resetAt <= now
  return zeroBuckets.every((b) => b.resetAt !== null && b.resetAt <= now);
}

/**
 * Orders the candidates for a request. Pure function: no network, no SQLite.
 *
 * Rules (spec §8):
 *  1. only enabled, non-invalid accounts; an expired cooldown becomes valid again
 *     — a cooldown without `cooldownUntil` is treated as already over (eligible),
 *       since discarding it would silently and permanently lose the account. An active
 *       cooldown only benches the account for the model family that drained: a family with
 *       quota left keeps it eligible (the wall is per family, the cooldown is per account)
 *  2. accounts with a measured quota of 0 are discarded unless their resetAt <= now
 *  3. explicit priority comes before quota
 *  4. known positive quota before unknown quota, unknown quota before expired zero quota
 *  5. within the group, decreasing quota and, on a tie, older use
 */
export function order(
  snapshot: readonly AccountSnapshot[],
  runtimeModel: string,
  now: number = Date.now(),
): AccountSnapshot[] {
  const eligible = snapshot.filter((account) => {
    if (!account.enabled) return false;
    if (account.status === "invalid") return false;
    const quota = summarizeQuota(account, runtimeModel);
    if (account.status === "cooldown") {
      // With no expiry recorded, the cooldown is considered over: keeping the
      // account ineligible forever would be a silent, permanent loss.
      if (account.cooldownUntil !== null && account.cooldownUntil > now) {
        // Still cooling down: keep the account only for a family with positive quota
        return quota !== null && quota > 0;
      }
    }
    if (quota === 0) {
      return hasExpiredZeroQuota(account, runtimeModel, now);
    }
    return true;
  });

  const scored = eligible.map((account) => ({ account, quota: summarizeQuota(account, runtimeModel) }));

  scored.sort((left, right) => {
    if (left.account.priority !== right.account.priority) {
      return right.account.priority - left.account.priority;
    }
    // Tier 1: positive quota (quota > 0)
    // Tier 2: unknown quota (quota === null)
    // Tier 3: zero quota whose resetAt passed (quota === 0)
    const tier = (q: number | null): number => {
      if (q !== null && q > 0) return 3;
      if (q === null) return 2;
      return 1;
    };
    const leftTier = tier(left.quota);
    const rightTier = tier(right.quota);
    if (leftTier !== rightTier) {
      return rightTier - leftTier;
    }
    if (left.quota !== null && right.quota !== null && left.quota !== right.quota) {
      return right.quota - left.quota;
    }
    return (left.account.lastUsedAt ?? 0) - (right.account.lastUsedAt ?? 0);
  });

  return scored.map((entry) => entry.account);
}
