import { PACING_TOLERANCE, paceScore } from "./pacing.js";
import type { AccountSnapshot } from "./store.js";

/**
 * The bucket-id prefix of the group a runtime model belongs to (spec §8): the backend
 * splits quota into "Gemini Models" (`gemini-*`) and "Claude and GPT models" (`3p-*`).
 * Returns `null` for a family with no known group, which scores as unknown quota.
 */
export function familyBucketPrefix(runtimeModel: string): string | null {
  if (/^gemini-/i.test(runtimeModel)) return "gemini-";
  // `gpt-` and not `gpt-oss-`: the backend's own group is "Claude and GPT models", so the
  // whole OpenAI family belongs to `3p-*`. A narrower match would rank a future GPT model
  // as unknown quota.
  if (/^(claude-|gpt-)/i.test(runtimeModel)) return "3p-";
  return null;
}

/**
 * The lowest remaining fraction across one family's buckets, or `null` when the account
 * reports no bucket for it — what a free-tier account looks like (spec §3.5).
 *
 * The minimum keeps the binding window in charge: a fresh 5h window is no help when the
 * weekly one is nearly spent.
 */
export function summarizePrefix(account: AccountSnapshot, bucketIdPrefix: string): number | null {
  const relevant = account.quota.filter((row) => row.bucketId.startsWith(bucketIdPrefix));
  if (relevant.length === 0) return null;
  return relevant.reduce((lowest, row) => Math.min(lowest, row.remainingFraction), 1);
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
  const bucketIdPrefix = familyBucketPrefix(runtimeModel);
  return bucketIdPrefix === null ? null : summarizePrefix(account, bucketIdPrefix);
}

function hasExpiredZeroQuota(account: AccountSnapshot, bucketIdPrefix: string, now: number): boolean {
  const relevant = account.quota.filter((row) => row.bucketId.startsWith(bucketIdPrefix));
  if (relevant.length === 0) return false;
  const zeroBuckets = relevant.filter((row) => row.remainingFraction === 0);
  if (zeroBuckets.length === 0) return false;
  // If zero quota, only eligible if all binding zero buckets have resetAt <= now
  return zeroBuckets.every((b) => b.resetAt !== null && b.resetAt <= now);
}

/**
 * Whether an account may serve a request from this family right now (spec §8 rules 1–2).
 * A `null` prefix means the family is unmeasured, so only the account-wide rules apply.
 *
 * Moved out of `order()` so the pool aggregate can report routability with the same
 * rules the selector uses (spec D4) instead of a second copy that could drift.
 */
export function isEligibleForFamily(
  account: AccountSnapshot,
  bucketIdPrefix: string | null,
  now: number,
): boolean {
  if (!account.enabled) return false;
  if (account.status === "invalid") return false;
  const quota = bucketIdPrefix === null ? null : summarizePrefix(account, bucketIdPrefix);
  if (account.status === "cooldown") {
    // With no expiry recorded, the cooldown is considered over: keeping the
    // account ineligible forever would be a silent, permanent loss.
    if (account.cooldownUntil !== null && account.cooldownUntil > now) {
      // Still cooling down: keep the account only for a family with positive quota
      return quota !== null && quota > 0;
    }
  }
  if (quota === 0) {
    return bucketIdPrefix !== null && hasExpiredZeroQuota(account, bucketIdPrefix, now);
  }
  return true;
}

interface Candidate {
  account: AccountSnapshot;
  quota: number | null;
  score: number | null;
}

function byLastUseThenId(left: Candidate, right: Candidate): number {
  const byUse = (left.account.lastUsedAt ?? 0) - (right.account.lastUsedAt ?? 0);
  if (byUse !== 0) return byUse;
  if (left.account.id === right.account.id) return 0;
  return left.account.id < right.account.id ? -1 : 1;
}

/**
 * Emits the scored positive tier: the top `PACING_TOLERANCE` band rotates by least
 * recent use, and the rest follow by pace score descending (spec D2's tolerance band).
 */
function orderByPace(candidates: readonly Candidate[]): Candidate[] {
  if (candidates.length === 0) return [];
  const best = Math.max(...candidates.map((candidate) => candidate.score ?? Number.NEGATIVE_INFINITY));
  const bandLimit = best - PACING_TOLERANCE;
  const band: Candidate[] = [];
  const outside: Candidate[] = [];
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

/** Emits one priority level in the spec D2 tier order, deterministically. */
function orderWithinPriority(candidates: readonly Candidate[]): Candidate[] {
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
  return [...orderByPace(scoredPositive), ...unscoredPositive, ...unknown, ...expiredZero];
}

/**
 * Orders the candidates for a request. Pure function: no network, no SQLite.
 *
 * Rules (spec §8, D2):
 *  1. only enabled, non-invalid accounts; an expired cooldown becomes valid again
 *     — a cooldown without `cooldownUntil` is treated as already over (eligible),
 *       since discarding it would silently and permanently lose the account. An active
 *       cooldown only benches the account for the model family that drained: a family with
 *       quota left keeps it eligible (the wall is per family, the cooldown is per account)
 *  2. accounts with a measured quota of 0 are discarded unless their resetAt <= now
 *  3. explicit priority comes before quota and pace
 *  4. known positive quota before unknown quota, unknown quota before expired zero quota
 *  5. known positive accounts with a normalizable window rank by pace score descending;
 *     the best scores within 2 pp rotate by least recent use so concurrent requests spread
 *     instead of herding. Accounts without `resetAt` (or with an unknown window) cannot
 *     be normalized and fall back to remaining quota descending, below every scored one.
 */
export function order(
  snapshot: readonly AccountSnapshot[],
  runtimeModel: string,
  now: number = Date.now(),
): AccountSnapshot[] {
  const bucketIdPrefix = familyBucketPrefix(runtimeModel);
  const candidates: Candidate[] = snapshot
    .filter((account) => isEligibleForFamily(account, bucketIdPrefix, now))
    .map((account) => ({
      account,
      quota: bucketIdPrefix === null ? null : summarizePrefix(account, bucketIdPrefix),
      score: bucketIdPrefix === null ? null : paceScore(account, bucketIdPrefix, now),
    }));

  // Explicit priority is the outermost key; a Map keeps each level's candidates in the
  // order they arrived, then the levels themselves are emitted highest first.
  const byPriority = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const level = byPriority.get(candidate.account.priority);
    if (level) level.push(candidate);
    else byPriority.set(candidate.account.priority, [candidate]);
  }

  return [...byPriority.keys()]
    .sort((left, right) => right - left)
    .flatMap((priority) => orderWithinPriority(byPriority.get(priority) ?? []))
    .map((candidate) => candidate.account);
}
