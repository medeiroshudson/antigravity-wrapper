import { describe, expect, it } from "vitest";
import { PACING_TOLERANCE, WINDOW_LENGTH_MS, bucketPacing, paceScore } from "../src/lib/accounts/pacing.js";
import type { AccountSnapshot, QuotaBucket } from "../src/lib/accounts/store.js";

const NOW = Date.parse("2026-10-21T15:43:40Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function bucket(over: Partial<QuotaBucket> = {}): QuotaBucket {
  return {
    accountId: "x",
    bucketId: "gemini-5h",
    window: "5h",
    displayName: "Limit Remaining",
    groupName: "Gemini Models",
    groupDescription: null,
    bucketDescription: null,
    remainingFraction: 1,
    resetAt: null,
    fetchedAt: NOW,
    ...over,
  };
}

function account(over: Partial<AccountSnapshot> & { id: string }): AccountSnapshot {
  return {
    email: `${over.id}@x.com`,
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: NOW + HOUR,
    projectId: "p",
    status: "active",
    cooldownUntil: null,
    lastError: null,
    quotaSummaryError: null,
    paidTierId: null,
    paidTierName: null,
    enabled: true,
    priority: 0,
    createdAt: 0,
    lastUsedAt: null,
    quota: [],
    ...over,
  };
}

describe("bucketPacing", () => {
  it("normalizes the window age and computes the deficit", () => {
    // A reset halfway through the 5h window means half of it has elapsed; 80% remaining
    // means 20% is consumed, so the account is 0.30 behind its own linear pace.
    const pacing = bucketPacing(bucket({ remainingFraction: 0.8, resetAt: NOW + 2.5 * HOUR }), NOW);
    expect(pacing?.elapsedFraction).toBe(0.5);
    expect(pacing?.consumedFraction).toBeCloseTo(0.19999999999999996, 10);
    expect(pacing?.deficit).toBeCloseTo(0.30000000000000004, 10);
  });

  it("clamps a reset beyond the window length to no elapsed time", () => {
    // Guard against clock skew: a reset further out than the window would otherwise
    // produce a negative elapsed fraction.
    const pacing = bucketPacing(bucket({ remainingFraction: 0.9, resetAt: NOW + 6 * HOUR }), NOW);
    expect(pacing?.elapsedFraction).toBe(0);
    expect(pacing?.deficit).toBeCloseTo(-0.1, 10);
  });

  it("clamps a past reset to a fully elapsed window", () => {
    // A reset an hour in the past means the window is already over (1.2 clamped to 1);
    // with 60% consumed the account is 0.40 behind the pace it should have kept.
    const pacing = bucketPacing(bucket({ remainingFraction: 0.4, resetAt: NOW - HOUR }), NOW);
    expect(pacing?.elapsedFraction).toBe(1);
    expect(pacing?.consumedFraction).toBeCloseTo(0.6, 10);
    expect(pacing?.deficit).toBeCloseTo(0.4, 10);
  });

  it("returns null for a missing resetAt or an unknown window", () => {
    expect(bucketPacing(bucket({ resetAt: null }), NOW)).toBeNull();
    expect(bucketPacing(bucket({ window: "daily", resetAt: NOW + HOUR }), NOW)).toBeNull();
  });
});

describe("paceScore", () => {
  it("returns the minimum deficit across the requested family's windows", () => {
    const a = account({
      id: "a",
      quota: [
        // 5h: half the window elapsed, 20% consumed => deficit 0.30.
        bucket({ remainingFraction: 0.8, resetAt: NOW + 2.5 * HOUR }),
        // weekly: half elapsed, 40% consumed => deficit 0.10, the binding window.
        bucket({ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.6, resetAt: NOW + 3.5 * DAY }),
        // Another family, further behind its own pace: must not influence the score.
        bucket({ bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetAt: NOW + 6.5 * DAY }),
      ],
    });
    expect(paceScore(a, "gemini-", NOW)).toBeCloseTo(0.1, 10);
  });

  it("skips buckets it cannot normalize and returns null when none remain", () => {
    const a = account({ id: "a", quota: [bucket(), bucket({ bucketId: "gemini-weekly", window: "weekly" })] });
    expect(paceScore(a, "gemini-", NOW)).toBeNull();
    expect(paceScore(account({ id: "b" }), "gemini-", NOW)).toBeNull();
  });

  it("exposes the tolerance used by the selector", () => {
    expect(PACING_TOLERANCE).toBe(0.02);
    expect(WINDOW_LENGTH_MS["5h"]).toBe(18_000_000);
    expect(WINDOW_LENGTH_MS.weekly).toBe(604_800_000);
  });
});
