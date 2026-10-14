import type { QuotaBucket } from "../accounts/store.js";
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
