import type { AccountSnapshot, QuotaBucket } from "../accounts/store.js";
import { toIsoUtc, toResetPhrase } from "./datetime.js";

export interface BucketView {
  name: string | null;
  bucketId: string;
  window: string;
  remainingPercent: number;
  remainingFraction: number;
  resetAt: string | null;
  resetsIn: string | null;
  description: string | null;
}

export interface GroupView {
  name: string;
  description: string | null;
  fetchedAt: string | null;
  buckets: BucketView[];
}

export interface FamilyQuotaSummary {
  available: boolean;
  remainingPercent: number;
  resetsIn: string | null;
}

export interface LeanPoolQuota {
  generatedAt: string;
  activeAccounts: number;
  gemini: FamilyQuotaSummary;
  claudeGpt: FamilyQuotaSummary;
}

/**
 * Assembles a lean summary of Gemini and Claude/GPT quota across all active accounts in the pool.
 *
 * - Active accounts: `enabled === true && status !== "invalid"` (expired cooldowns are treated as active).
 * - For each family:
 *   - `available`: true if at least one active account has usable quota (> 0%) for that family.
 *   - `remainingPercent`: best remaining percentage among active accounts with measured quota (0..100).
 *   - `resetsIn`: human-readable time remaining until the earliest quota reset among depleted/partially-used buckets.
 */
export function toLeanPoolQuota(
  accounts: readonly AccountSnapshot[],
  now: number = Date.now(),
): LeanPoolQuota {
  const active = accounts.filter((account) => {
    if (!account.enabled) return false;
    if (account.status === "invalid") return false;
    return true;
  });

  const summarizeFamily = (prefix: string): FamilyQuotaSummary => {
    let bestFraction = 0;
    let hasKnownQuota = false;
    let earliestResetAt: number | null = null;

    for (const account of active) {
      const familyBuckets = account.quota.filter((b) => b.bucketId.startsWith(prefix));
      if (familyBuckets.length === 0) continue;

      hasKnownQuota = true;

      // The account's effective quota for this family is the lowest remainingFraction across its buckets
      const accountLowest = familyBuckets.reduce(
        (lowest, b) => Math.min(lowest, b.remainingFraction),
        1,
      );

      // If the account is in active cooldown, but this family has 0 quota or cooldown applies
      const inCooldown = account.status === "cooldown" && (account.cooldownUntil ?? 0) > now;
      const effectiveFraction = inCooldown && accountLowest <= 0 ? 0 : accountLowest;

      if (effectiveFraction > bestFraction) {
        bestFraction = effectiveFraction;
      }

      // Check reset times for buckets that are partially or fully consumed (< 100%)
      for (const bucket of familyBuckets) {
        if (bucket.remainingFraction < 1 && bucket.resetAt !== null && bucket.resetAt > now) {
          if (earliestResetAt === null || bucket.resetAt < earliestResetAt) {
            earliestResetAt = bucket.resetAt;
          }
        }
      }
    }

    const available = hasKnownQuota && bestFraction > 0;
    const remainingPercent = Math.max(0, Math.min(100, Math.round(bestFraction * 100)));

    return {
      available,
      remainingPercent,
      resetsIn: toResetPhrase(earliestResetAt, now),
    };
  };

  return {
    generatedAt: toIsoUtc(now) ?? new Date(now).toISOString(),
    activeAccounts: active.length,
    gemini: summarizeFamily("gemini-"),
    claudeGpt: summarizeFamily("3p-"),
  };
}

/**
 * Assembles the group view the Antigravity app shows: one group per model family, one
 * bucket per window, an integer percent and the time remaining in words (spec §9).
 *
 * Pure: no I/O, and the order is the backend's throughout — groups in the order their
 * first bucket arrived, buckets in the order the backend listed them. Nothing is sorted
 * here, so a client rendering the payload shows what the app shows.
 *
 * `remainingFraction` stays beside the percentage: the integer is what a person reads,
 * the exact number is what explains a selection decision (spec §4 D7).
 */
export function toGroupsView(rows: readonly QuotaBucket[], now: number = Date.now()): GroupView[] {
  const groups = new Map<string, GroupView>();

  for (const row of rows) {
    const name = row.groupName;
    // Without a group name there is no heading to put the numbers under, and inventing
    // one would attribute the reading to a group it may not belong to.
    if (!name) continue;

    let group = groups.get(name);
    if (!group) {
      group = {
        name,
        description: row.groupDescription,
        fetchedAt: toIsoUtc(row.fetchedAt),
        buckets: [],
      };
      groups.set(name, group);
    }

    group.buckets.push({
      name: row.displayName,
      bucketId: row.bucketId,
      window: row.window,
      remainingPercent: Math.max(0, Math.min(100, Math.round(row.remainingFraction * 100))),
      remainingFraction: row.remainingFraction,
      resetAt: toIsoUtc(row.resetAt),
      resetsIn: toResetPhrase(row.resetAt, now),
      description: row.bucketDescription,
    });
  }

  return [...groups.values()];
}
