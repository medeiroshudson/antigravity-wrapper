import type { AccountSnapshot, QuotaBucket } from "./store.js";

/**
 * The band within which two pace scores are treated as near equal (spec D2). Inside
 * it the selector falls back to least-recently-used, so concurrent and bursty
 * requests rotate instead of herding on the single best score.
 */
export const PACING_TOLERANCE = 0.02;

/**
 * How long each window the backend reports actually lasts. A window of unknown
 * length cannot be normalized and scores as unknown rather than being guessed at
 * (spec D1).
 */
export const WINDOW_LENGTH_MS: Readonly<Record<string, number>> = {
  "5h": 18_000_000,
  weekly: 604_800_000,
};

export interface BucketPacing {
  elapsedFraction: number;
  consumedFraction: number;
  deficit: number;
}

/**
 * Places one bucket on its own window's linear pace (spec D1).
 *
 * `elapsedFraction` is the share of the window that has already run, clamped to
 * [0, 1] so a stale or skewed `resetAt` cannot report an out-of-range age. The
 * deficit is `elapsed - consumed`: positive means the quota is being spent slower
 * than the window resets (room to take traffic), negative means the account is
 * ahead of pace.
 *
 * Returns `null` when the window length is unknown or no reset time was reported.
 * The snapshot cannot be normalized then, and a made-up number would rank the
 * account against measured ones (spec D2 keeps those as an explicit fallback).
 */
export function bucketPacing(bucket: QuotaBucket, now: number): BucketPacing | null {
  const length = WINDOW_LENGTH_MS[bucket.window.toLowerCase()];
  if (length === undefined) return null;
  const resetAt = bucket.resetAt;
  if (resetAt === null || !Number.isFinite(resetAt)) return null;
  const elapsedFraction = Math.min(1, Math.max(0, (length - (resetAt - now)) / length));
  const consumedFraction = 1 - bucket.remainingFraction;
  return { elapsedFraction, consumedFraction, deficit: elapsedFraction - consumedFraction };
}

/**
 * The account's pace score for one family: the lowest deficit among the family's
 * normalizable buckets (spec D1), or `null` when it has none. The minimum keeps the
 * binding window in charge — a fresh window does not excuse a nearly spent sibling.
 */
export function paceScore(account: AccountSnapshot, bucketIdPrefix: string, now: number): number | null {
  const deficits = account.quota
    .filter((bucket) => bucket.bucketId.startsWith(bucketIdPrefix))
    .map((bucket) => bucketPacing(bucket, now))
    .filter((pacing): pacing is BucketPacing => pacing !== null)
    .map((pacing) => pacing.deficit);
  return deficits.length === 0 ? null : Math.min(...deficits);
}
