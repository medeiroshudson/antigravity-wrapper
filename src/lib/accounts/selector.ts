import { paceScore } from "./pacing.js";
import type { AccountSnapshot, CooldownRow } from "./store.js";
import { createStrategy } from "./strategies/registry.js";
import type { EligibleCandidate, LoadBalanceStrategy } from "./strategies/types.js";

/** Ranking used when no strategy is passed: what the pool did before strategies existed. */
const DEFAULT_STRATEGY = createStrategy("pace-deficit");

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
 * The benches that bind this family right now: `*` always applies, a family row applies to
 * its own prefix, and an unmeasured family (`null`) has no prefix of its own, so only `*`
 * can bench it.
 */
function activeCooldowns(
  account: AccountSnapshot,
  bucketIdPrefix: string | null,
  now: number,
): CooldownRow[] {
  return account.cooldowns.filter(
    (row) =>
      row.until > now &&
      (row.scope === "*" || (bucketIdPrefix !== null && row.scope === bucketIdPrefix)),
  );
}

/**
 * Every rule of `isEligibleForFamily` except the bench. Kept apart so the relaxation in
 * `orderDecision` can ask "would this account serve if the cooldown were over?" without
 * copying the other rules into a second place that could drift.
 */
function eligibleIgnoringCooldown(
  account: AccountSnapshot,
  bucketIdPrefix: string | null,
  now: number,
): boolean {
  // Onboarding writes `projectId` last: an account without one cannot build a request,
  // so admitting it only burns a failover slot (and, while `status` is still `active`,
  // it sorts first among unknown-quota accounts).
  if (!account.projectId) return false;
  if (!account.enabled) return false;
  if (account.status === "invalid") return false;
  if (bucketIdPrefix === null) return true;
  const quota = summarizePrefix(account, bucketIdPrefix);
  if (quota === 0) return hasExpiredZeroQuota(account, bucketIdPrefix, now);
  return true;
}

/**
 * Whether an account may serve a request from this family right now (spec §8 rules 1–2).
 * A `null` prefix means the family is unmeasured, so only the account-wide rules apply.
 *
 * The bench is read from `account.cooldowns`, not from `status`: the table is the source of
 * truth and it names the family, which is what lets one drained family leave the other one
 * serving. The quota re-admission rule that used to soften the account-wide cooldown is
 * gone with the reason for it: a cooldown now says which family it belongs to.
 *
 * Moved out of `order()` so the pool aggregate can report routability with the same
 * rules the selector uses (spec D4) instead of a second copy that could drift.
 */
export function isEligibleForFamily(
  account: AccountSnapshot,
  bucketIdPrefix: string | null,
  now: number,
): boolean {
  if (activeCooldowns(account, bucketIdPrefix, now).length > 0) return false;
  return eligibleIgnoringCooldown(account, bucketIdPrefix, now);
}

/**
 * Orders the candidates for a request. Pure function: no network, no SQLite.
 *
 * Rules (spec §8, D2):
 *  1. only enabled, non-invalid accounts; an active cooldown benches the account for the
 *     family it names (`*` for the whole account), and only that family
 *  2. accounts with a measured quota of 0 are discarded unless their resetAt <= now
 *  3. explicit priority comes before quota and pace
 *  4. within a priority level, ranking is the strategy's job (default `pace-deficit`:
 *     known positive quota before unknown quota, unknown before expired zero, and the
 *     near-best pace scores within the tolerance band rotate by least recent use)
 */
export function order(
  snapshot: readonly AccountSnapshot[],
  runtimeModel: string,
  now: number = Date.now(),
  strategy: LoadBalanceStrategy = DEFAULT_STRATEGY,
  inFlightByAccount?: ReadonlyMap<string, number>,
): AccountSnapshot[] {
  return orderDecision(snapshot, runtimeModel, now, strategy, inFlightByAccount).accounts;
}

export interface OrderDecision {
  accounts: AccountSnapshot[];
  /** How many accounts the single-eligible-account exception admitted. */
  relaxed: number;
}

/**
 * `order()` plus the one exception that cannot be expressed as a filter.
 *
 * When the normal pass has nothing for this family, admit the accounts excluded *only* by
 * an active throttle: a 30 s wait the backend named may already be over, and offering the
 * caller an exhausted pool when a plausible account exists is the worse failure. A quota
 * wall is never relaxed — it does not care how politely the request retries — and neither
 * is an account that fails another rule (no project, disabled, zero quota).
 */
export function orderDecision(
  snapshot: readonly AccountSnapshot[],
  runtimeModel: string,
  now: number = Date.now(),
  strategy: LoadBalanceStrategy = DEFAULT_STRATEGY,
  inFlightByAccount?: ReadonlyMap<string, number>,
): OrderDecision {
  const bucketIdPrefix = familyBucketPrefix(runtimeModel);
  const scoring = (account: AccountSnapshot): EligibleCandidate => ({
    account,
    quota: bucketIdPrefix === null ? null : summarizePrefix(account, bucketIdPrefix),
    score: bucketIdPrefix === null ? null : paceScore(account, bucketIdPrefix, now),
  });

  const normal = snapshot.filter((account) => isEligibleForFamily(account, bucketIdPrefix, now));
  let relaxed: readonly AccountSnapshot[] = [];
  if (normal.length === 0) {
    relaxed = snapshot.filter((account) => {
      if (!eligibleIgnoringCooldown(account, bucketIdPrefix, now)) return false;
      const benches = activeCooldowns(account, bucketIdPrefix, now);
      return benches.length > 0 && benches.every((row) => row.kind === "transient_rate_limit");
    });
  }

  const candidates = (relaxed.length > 0 ? relaxed : normal).map(scoring);
  // Priority tiers are part of the strategy too (the registry wraps every strategy in the
  // tiered one), so this stays a single delegation: eligibility here, ranking there.
  const accounts = strategy.rank(candidates, {
    runtimeModel,
    bucketIdPrefix,
    now,
    inFlightByAccount,
  });
  return { accounts, relaxed: relaxed.length };
}
