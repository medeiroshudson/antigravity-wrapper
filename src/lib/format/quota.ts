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

export interface WindowQuotaSummary {
  remainingPercent: number | null;
  resetsIn: string | null;
}

export interface FamilyQuotaSummary {
  available: boolean;
  "5h": WindowQuotaSummary;
  weekly: WindowQuotaSummary;
}

export interface LeanPoolQuota {
  generatedAt: string;
  activeAccounts: number;
  gemini: FamilyQuotaSummary;
  claudeGpt: FamilyQuotaSummary;
}

/**
 * Assembles a lean summary of Gemini and Claude/GPT quota across all active accounts in the pool,
 * broken down by the two authoritative windows: 5h and weekly.
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

  const summarizeWindow = (
    accounts: readonly AccountSnapshot[],
    prefix: string,
    windowName: string,
  ): WindowQuotaSummary => {
    const windowBuckets = accounts.flatMap((account) => {
      const inActiveCooldown = account.status === "cooldown" && (account.cooldownUntil ?? 0) > now;
      return account.quota
        .filter(
          (bucket) =>
            bucket.bucketId.startsWith(prefix) &&
            bucket.window.toLowerCase() === windowName.toLowerCase(),
        )
        .map((bucket) => ({
          bucket,
          remainingFraction: inActiveCooldown ? 0 : bucket.remainingFraction,
        }));
    });

    if (windowBuckets.length === 0) {
      return { remainingPercent: null, resetsIn: null };
    }

    const bestFraction = Math.max(...windowBuckets.map(({ remainingFraction }) => remainingFraction));
    const resetAt = windowBuckets
      .filter(({ remainingFraction, bucket }) =>
        remainingFraction === bestFraction && bucket.resetAt !== null && bucket.resetAt > now,
      )
      .reduce<number | null>(
        (earliest, { bucket }) =>
          earliest === null || (bucket.resetAt !== null && bucket.resetAt < earliest)
            ? bucket.resetAt
            : earliest,
        null,
      );

    return {
      remainingPercent: Math.max(0, Math.min(100, Math.round(bestFraction * 100))),
      resetsIn: toResetPhrase(resetAt, now),
    };
  };

  const summarizeFamily = (prefix: string): FamilyQuotaSummary => {
    const accountsWithUsableQuota = active.filter((account) => {
      const familyBuckets = account.quota.filter((bucket) => bucket.bucketId.startsWith(prefix));
      if (familyBuckets.length === 0) return false;
      const inActiveCooldown = account.status === "cooldown" && (account.cooldownUntil ?? 0) > now;
      return !inActiveCooldown && familyBuckets.every((bucket) => bucket.remainingFraction > 0);
    });

    return {
      available: accountsWithUsableQuota.length > 0,
      "5h": summarizeWindow(active, prefix, "5h"),
      weekly: summarizeWindow(active, prefix, "weekly"),
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
