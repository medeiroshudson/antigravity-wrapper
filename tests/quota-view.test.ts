import { describe, expect, it } from "vitest";
import type { AccountSnapshot, QuotaBucket } from "../src/lib/accounts/store.js";
import { toGroupsView, toLeanPoolQuota } from "../src/lib/format/quota.js";
import { REAL_POOL, REAL_POOL_NOW } from "./fixtures/pool.js";

const NOW = Date.parse("2026-10-14T00:00:00Z");

function row(over: Partial<QuotaBucket> = {}): QuotaBucket {
  return {
    accountId: "a1",
    bucketId: "gemini-weekly",
    window: "weekly",
    displayName: "Weekly Limit Remaining",
    groupName: "Gemini Models",
    groupDescription: "Models within this group: Gemini Flash, Gemini Pro",
    bucketDescription: "You have used some of your weekly limit.",
    remainingFraction: 0.99093425,
    resetAt: Date.parse("2026-10-19T20:43:54Z"),
    fetchedAt: Date.parse("2026-10-14T00:00:00Z"),
    ...over,
  };
}

describe("toGroupsView", () => {
  it("renders integer percent, ISO reset and readable time remaining", () => {
    const [group] = toGroupsView([row()], NOW);
    const [bucket] = group?.buckets ?? [];

    expect(bucket?.remainingPercent).toBe(99);
    expect(bucket?.remainingFraction).toBe(0.99093425);
    expect(bucket?.resetAt).toBe("2026-10-19T20:43:54Z");
    expect(bucket?.resetsIn).toBe("5d 20h");
  });

  it("keeps the backend's group and bucket order", () => {
    const groups = toGroupsView(
      [
        row({ bucketId: "gemini-weekly" }),
        row({ bucketId: "gemini-5h", window: "5h" }),
        row({ bucketId: "3p-weekly", groupName: "Claude and GPT models" }),
        row({ bucketId: "3p-5h", window: "5h", groupName: "Claude and GPT models" }),
      ],
      NOW,
    );

    // Weekly before 5h, Gemini before Claude and GPT: the order the app shows (spec §9).
    // Nothing is reordered here, so a client renders what it receives.
    expect(groups.map((group) => group.name)).toEqual(["Gemini Models", "Claude and GPT models"]);
    expect(groups[0]?.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "gemini-weekly",
      "gemini-5h",
    ]);
    expect(groups[1]?.buckets.map((bucket) => bucket.bucketId)).toEqual(["3p-weekly", "3p-5h"]);
  });

  it("carries each group's name, description and one coherent timestamp", () => {
    const [group] = toGroupsView([row()], NOW);
    expect(group?.name).toBe("Gemini Models");
    expect(group?.description).toBe("Models within this group: Gemini Flash, Gemini Pro");
    expect(group?.fetchedAt).toBe("2026-10-14T00:00:00Z");
  });

  it("rounds to the nearest integer and clamps to 0..100", () => {
    const group = toGroupsView(
      [
        row({ bucketId: "b1", remainingFraction: 0 }),
        row({ bucketId: "b2", remainingFraction: 0.004 }),
        row({ bucketId: "b3", remainingFraction: 0.005 }),
        row({ bucketId: "b4", remainingFraction: 0.5 }),
        row({ bucketId: "b5", remainingFraction: 1 }),
        row({ bucketId: "b6", remainingFraction: 1.5 }),
        row({ bucketId: "b7", remainingFraction: -0.2 }),
      ],
      NOW,
    )[0];

    expect(group?.buckets.map((bucket) => bucket.remainingPercent)).toEqual([
      0, 0, 1, 50, 100, 100, 0,
    ]);
  });

  it("renders a bucket with no reset as null resetAt and null resetsIn", () => {
    const [group] = toGroupsView([row({ resetAt: null })], NOW);
    const [bucket] = group?.buckets ?? [];

    expect(bucket?.resetAt).toBeNull();
    expect(bucket?.resetsIn).toBeNull();
  });

  it("returns an empty list for no rows", () => {
    expect(toGroupsView([], NOW)).toEqual([]);
  });

  it("skips a row with no group name instead of inventing a heading", () => {
    // A group heading is the only thing that makes the numbers readable here; a row
    // without one cannot be presented, and inventing a label would misattribute it.
    expect(toGroupsView([row({ groupName: null })], NOW)).toEqual([]);
  });

  it("keeps a group's buckets together under one heading", () => {
    const groups = toGroupsView(
      [row({ bucketId: "gemini-weekly" }), row({ bucketId: "gemini-5h", window: "5h" })],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.buckets).toHaveLength(2);
  });

  it("exposes window age and pace deficit per bucket", () => {
    const bucket = row({
      bucketId: "gemini-5h",
      window: "5h",
      remainingFraction: 0.8,
      resetAt: NOW + 2.5 * 3_600_000,
    });
    const [group] = toGroupsView([bucket], NOW);

    // Half of the five-hour window has run and 20% is consumed: the account is 30 points
    // behind pace, and the integer age is what makes the selector's ranking auditable.
    expect(group?.buckets[0]?.windowElapsedPercent).toBe(50);
    expect(group?.buckets[0]?.pacingDeficit).toBeCloseTo(0.3, 10);
  });

  it("returns null pacing fields when the window cannot be normalized", () => {
    const [missingReset] = toGroupsView([row({ resetAt: null })], NOW);
    expect(missingReset?.buckets[0]?.windowElapsedPercent).toBeNull();
    expect(missingReset?.buckets[0]?.pacingDeficit).toBeNull();

    // An unknown window has no length to normalize against, so it stays unknown rather
    // than being guessed at (spec D1).
    const [unknownWindow] = toGroupsView(
      [row({ bucketId: "gemini-monthly", window: "monthly" })],
      NOW,
    );
    expect(unknownWindow?.buckets[0]?.windowElapsedPercent).toBeNull();
    expect(unknownWindow?.buckets[0]?.pacingDeficit).toBeNull();
  });
});

describe("toLeanPoolQuota", () => {
  function makeAccount(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
    return {
      id: "acc-1",
      email: "test@example.com",
      refreshToken: "rt",
      accessToken: "at",
      accessExpiresAt: NOW + 3600_000,
      projectId: "proj-1",
      status: "active",
      cooldownUntil: null,
      lastError: null,
      quotaSummaryError: null,
      paidTierId: "g1-pro",
      paidTierName: "Pro",
      enabled: true,
      priority: 0,
      createdAt: NOW - 86400_000,
      lastUsedAt: null,
      quota: [],
      ...over,
    };
  }

  it("returns unknown windows when there are no accounts", () => {
    const summary = toLeanPoolQuota([], NOW);
    expect(summary.activeAccounts).toBe(0);
    expect(summary.generatedAt).toBe("2026-10-14T00:00:00Z");
    expect(summary.gemini).toEqual({
      available: false,
      availableAccounts: 0,
      observedAt: null,
      "5h": {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
    });
    expect(summary.claudeGpt).toEqual({
      available: false,
      availableAccounts: 0,
      observedAt: null,
      "5h": {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
    });
  });

  it("ignores disabled or invalid accounts", () => {
    const disabledAcc = makeAccount({
      id: "disabled",
      enabled: false,
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 })],
    });
    const invalidAcc = makeAccount({
      id: "invalid",
      status: "invalid",
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9 })],
    });

    const summary = toLeanPoolQuota([disabledAcc, invalidAcc], NOW);
    expect(summary.activeAccounts).toBe(0);
    expect(summary.gemini).toEqual({
      available: false,
      availableAccounts: 0,
      observedAt: null,
      "5h": {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
    });
  });

  it("reports the pool mean and the worst account, not the best account", () => {
    const best = makeAccount({
      id: "best",
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 })],
    });
    const tightest = makeAccount({
      id: "tightest",
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.2 })],
    });

    const summary = toLeanPoolQuota([best, tightest], NOW);

    // The old formula reported the best account's 80 here. The pool holds 50 on average,
    // and its tightest account has 20 left — the capacity a request may actually meet.
    expect(summary.gemini["5h"].remainingPercent).toBe(50);
    expect(summary.gemini["5h"].worstRemainingPercent).toBe(20);
    expect(summary.gemini["5h"].measuredAccounts).toBe(2);
  });

  it("counts measured accounts and reports the soonest future reset", () => {
    const accounts = [1, 2, 3].map((hours) =>
      makeAccount({
        id: `acc-${hours}`,
        quota: [
          row({
            bucketId: "gemini-5h",
            window: "5h",
            remainingFraction: 0.9,
            resetAt: NOW + hours * 3600_000,
          }),
        ],
      }),
    );

    const summary = toLeanPoolQuota(accounts, NOW);

    // One window per account, all reporting: the counts and the earliest refill are what
    // say whether the number is trustworthy and when the pool starts refilling.
    expect(summary.gemini["5h"]).toEqual({
      remainingPercent: 90,
      worstRemainingPercent: 90,
      measuredAccounts: 3,
      nextResetAt: "2026-10-14T01:00:00Z",
      resetsIn: "1h 0m",
    });
  });

  it("includes an active cooldown account at its reported capacity (no zeroing)", () => {
    const cooling = makeAccount({
      id: "cooling",
      status: "cooldown",
      cooldownUntil: NOW + 3600_000,
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 })],
    });
    const active = makeAccount({
      id: "active",
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.4 })],
    });

    const summary = toLeanPoolQuota([cooling, active], NOW);

    // A cooldown benches routing, not capacity: the account's quota stays in the pool
    // (spec D4). The old branch zeroed the cooling account and reported the remaining 40;
    // the pool's measured mean is 60.
    expect(summary.activeAccounts).toBe(2);
    expect(summary.gemini["5h"].remainingPercent).toBe(60);
    expect(summary.gemini["5h"].worstRemainingPercent).toBe(40);
    expect(summary.gemini["5h"].measuredAccounts).toBe(2);
  });

  it("keeps 'available' as measured usable capacity and reports routability separately", () => {
    // Free tier: no buckets means no capacity to measure, but the selector may still rank
    // the account on unknown quota — so routability is a separate number.
    const freeTier = toLeanPoolQuota([makeAccount({ id: "free" })], NOW);
    expect(freeTier.gemini).toEqual({
      available: false,
      availableAccounts: 1,
      observedAt: null,
      "5h": {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
    });

    // Drained: zero is a real measurement, so the mean is 0 rather than null; nothing is
    // usable until the window resets, so the family is neither available nor routable.
    const drained = toLeanPoolQuota(
      [
        makeAccount({
          id: "drained",
          quota: [
            row({
              bucketId: "gemini-5h",
              window: "5h",
              remainingFraction: 0,
              resetAt: NOW + 3600_000,
            }),
          ],
        }),
      ],
      NOW,
    );
    expect(drained.gemini.available).toBe(false);
    expect(drained.gemini.availableAccounts).toBe(0);
    expect(drained.gemini["5h"].remainingPercent).toBe(0);
    expect(drained.gemini["5h"].worstRemainingPercent).toBe(0);
    expect(drained.gemini["5h"].measuredAccounts).toBe(1);
  });

  it("keeps a cooling-only pool routable but not available", () => {
    // An active cooldown benches routing only for the family that drained; the selector
    // still deems this account eligible for Gemini because its family quota is positive.
    // Capacity, however, is measured on usable accounts, so a pool with no non-cooling
    // account is not available — while its reported fraction stays real, not zeroed.
    const cooling = makeAccount({
      id: "cooling",
      status: "cooldown",
      cooldownUntil: NOW + 3600_000,
      quota: [row({ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 })],
    });

    const summary = toLeanPoolQuota([cooling], NOW);

    expect(summary.gemini.available).toBe(false);
    expect(summary.gemini.availableAccounts).toBe(1);
    expect(summary.gemini["5h"].remainingPercent).toBe(80);
    expect(summary.gemini["5h"].worstRemainingPercent).toBe(80);
    expect(summary.gemini["5h"].measuredAccounts).toBe(1);
  });

  it("reports observedAt as the oldest reading", () => {
    const fresh = makeAccount({
      id: "fresh",
      quota: [row({ bucketId: "gemini-5h", window: "5h", fetchedAt: NOW })],
    });
    const stale = makeAccount({
      id: "stale",
      quota: [row({ bucketId: "gemini-5h", window: "5h", fetchedAt: NOW - 120_000 })],
    });

    const summary = toLeanPoolQuota([fresh, stale], NOW);

    // Staleness is explicit: the aggregate is only as fresh as its oldest reading.
    expect(summary.gemini.observedAt).toBe("2026-10-13T23:58:00Z");
  });

  it("replays the real snapshot", () => {
    const summary = toLeanPoolQuota(REAL_POOL, REAL_POOL_NOW);

    expect(summary.activeAccounts).toBe(3);
    expect(summary.generatedAt).toBe("2026-10-21T15:43:40Z");
    expect(summary.gemini).toEqual({
      available: true,
      availableAccounts: 3,
      observedAt: "2026-10-21T15:43:33Z",
      "5h": {
        remainingPercent: 89,
        worstRemainingPercent: 77,
        measuredAccounts: 3,
        nextResetAt: "2026-10-21T16:54:32Z",
        resetsIn: "1h 10m",
      },
      weekly: {
        remainingPercent: 54,
        worstRemainingPercent: 53,
        measuredAccounts: 3,
        nextResetAt: "2026-10-23T21:54:24Z",
        resetsIn: "2d 6h",
      },
    });
    expect(summary.claudeGpt).toEqual({
      available: true,
      availableAccounts: 3,
      observedAt: "2026-10-21T15:43:33Z",
      "5h": {
        remainingPercent: 100,
        worstRemainingPercent: 100,
        measuredAccounts: 3,
        nextResetAt: "2026-10-21T20:43:33Z",
        resetsIn: "4h 59m",
      },
      weekly: {
        remainingPercent: 100,
        worstRemainingPercent: 100,
        measuredAccounts: 3,
        nextResetAt: "2026-10-28T00:53:19Z",
        resetsIn: "6d 9h",
      },
    });
  });
});
