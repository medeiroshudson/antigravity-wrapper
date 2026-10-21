import type { AccountSnapshot, QuotaBucket } from "../../src/lib/accounts/store.js";

/**
 * The pool one real quota reading produced on 2026-10-21T15:43Z (spec §4, replay case):
 * three pro accounts whose 5h windows started at different times and whose weekly
 * windows are misaligned. Replayed by the selector and pool-view tests so the ranking
 * and the aggregate are pinned to measured data instead of a hand-built shape.
 */
export const REAL_POOL_NOW = Date.parse("2026-10-21T15:43:40Z");

const HOUR = 3_600_000;

function iso(value: string): number {
  return Date.parse(value);
}

function bucket(
  accountId: string,
  bucketId: string,
  remainingFraction: number,
  resetAt: string,
  fetchedAt: string,
): QuotaBucket {
  const weekly = bucketId.endsWith("weekly");
  return {
    accountId,
    bucketId,
    window: weekly ? "weekly" : "5h",
    displayName: "Limit Remaining",
    groupName: bucketId.startsWith("gemini-") ? "Gemini Models" : "Claude and GPT models",
    groupDescription: null,
    bucketDescription: null,
    remainingFraction,
    resetAt: iso(resetAt),
    fetchedAt: iso(fetchedAt),
  };
}

function poolAccount(
  id: string,
  lastUsedAt: string,
  quota: QuotaBucket[],
  over: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    id,
    email: `${id}@x.com`,
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: REAL_POOL_NOW + HOUR,
    projectId: "pool-project",
    status: "active",
    cooldownUntil: null,
    lastError: null,
    quotaSummaryError: null,
    paidTierId: "g1-pro-tier",
    paidTierName: null,
    enabled: true,
    priority: 0,
    createdAt: 0,
    lastUsedAt: iso(lastUsedAt),
    quota,
    ...over,
  };
}

const ACCOUNT_492B = "account-492b954c1a93c92f";
const ACCOUNT_123E = "account-123e90731bac6450";
const ACCOUNT_9A15 = "account-9a15b1ef6fde541a";

export const REAL_POOL: AccountSnapshot[] = [
  poolAccount(ACCOUNT_492B, "2026-10-18T20:58:48Z", [
    bucket(ACCOUNT_492B, "gemini-5h", 0.9498, "2026-10-21T20:13:26Z", "2026-10-21T15:43:33Z"),
    bucket(ACCOUNT_492B, "gemini-weekly", 0.5371, "2026-10-23T21:58:09Z", "2026-10-21T15:43:33Z"),
    bucket(ACCOUNT_492B, "3p-5h", 1, "2026-10-21T20:43:33Z", "2026-10-21T15:43:33Z"),
    bucket(ACCOUNT_492B, "3p-weekly", 1, "2026-10-28T15:43:33Z", "2026-10-21T15:43:33Z"),
  ]),
  poolAccount(ACCOUNT_123E, "2026-10-18T20:27:11Z", [
    bucket(ACCOUNT_123E, "gemini-5h", 0.9614, "2026-10-21T20:28:38Z", "2026-10-21T15:43:38Z"),
    bucket(ACCOUNT_123E, "gemini-weekly", 0.5262, "2026-10-23T21:54:24Z", "2026-10-21T15:43:38Z"),
    bucket(ACCOUNT_123E, "3p-5h", 1, "2026-10-21T20:43:38Z", "2026-10-21T15:43:38Z"),
    bucket(ACCOUNT_123E, "3p-weekly", 1, "2026-10-28T00:53:19Z", "2026-10-21T15:43:38Z"),
  ]),
  poolAccount(
    ACCOUNT_9A15,
    "2026-10-20T04:25:57Z",
    [
      bucket(ACCOUNT_9A15, "gemini-5h", 0.766, "2026-10-21T16:54:32Z", "2026-10-21T15:43:35Z"),
      bucket(ACCOUNT_9A15, "gemini-weekly", 0.5486, "2026-10-25T21:14:38Z", "2026-10-21T15:43:35Z"),
      bucket(ACCOUNT_9A15, "3p-5h", 1, "2026-10-21T20:43:35Z", "2026-10-21T15:43:35Z"),
      bucket(ACCOUNT_9A15, "3p-weekly", 1, "2026-10-28T15:43:35Z", "2026-10-21T15:43:35Z"),
    ],
    { status: "cooldown", cooldownUntil: iso("2026-10-22T19:54:52Z") },
  ),
];
