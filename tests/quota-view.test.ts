import { describe, expect, it } from "vitest";
import type { AccountSnapshot, QuotaBucket } from "../src/lib/accounts/store.js";
import { toGroupsView, toLeanPoolQuota } from "../src/lib/format/quota.js";

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

  it("returns zeroed summary when there are no accounts", () => {
    const summary = toLeanPoolQuota([], NOW);
    expect(summary.activeAccounts).toBe(0);
    expect(summary.generatedAt).toBe("2026-10-14T00:00:00Z");
    expect(summary.gemini).toEqual({
      available: false,
      remainingPercent: 0,
      resetsIn: null,
    });
    expect(summary.claudeGpt).toEqual({
      available: false,
      remainingPercent: 0,
      resetsIn: null,
    });
  });

  it("ignores disabled or invalid accounts", () => {
    const disabledAcc = makeAccount({
      id: "disabled",
      enabled: false,
      quota: [row({ bucketId: "gemini-5h", remainingFraction: 0.9 })],
    });
    const invalidAcc = makeAccount({
      id: "invalid",
      status: "invalid",
      quota: [row({ bucketId: "gemini-5h", remainingFraction: 0.9 })],
    });

    const summary = toLeanPoolQuota([disabledAcc, invalidAcc], NOW);
    expect(summary.activeAccounts).toBe(0);
    expect(summary.gemini.available).toBe(false);
    expect(summary.gemini.remainingPercent).toBe(0);
  });

  it("calculates best remainingPercent and nearest resetsIn across active accounts", () => {
    const acc1 = makeAccount({
      id: "acc-1",
      quota: [
        row({
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.8,
          resetAt: NOW + 7200_000, // in 2h
        }),
        row({
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.4,
          resetAt: NOW + 3600_000, // in 1h
        }),
      ],
    });

    const acc2 = makeAccount({
      id: "acc-2",
      quota: [
        row({
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.95,
          resetAt: NOW + 14400_000, // in 4h
        }),
        row({
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.1,
          resetAt: NOW + 1800_000, // in 30m
        }),
      ],
    });

    const summary = toLeanPoolQuota([acc1, acc2], NOW);
    expect(summary.activeAccounts).toBe(2);

    // Gemini: best fraction is 0.95 -> 95%, nearest reset with remainingFraction < 1 is 2h
    expect(summary.gemini.available).toBe(true);
    expect(summary.gemini.remainingPercent).toBe(95);
    expect(summary.gemini.resetsIn).toBe("2h 0m");

    // Claude/GPT: best fraction is 0.4 -> 40%, nearest reset with remainingFraction < 1 is 30m
    expect(summary.claudeGpt.available).toBe(true);
    expect(summary.claudeGpt.remainingPercent).toBe(40);
    expect(summary.claudeGpt.resetsIn).toBe("30m");
  });

  it("handles accounts in active cooldown whose quota is 0", () => {
    const cooldownAcc = makeAccount({
      id: "acc-cd",
      status: "cooldown",
      cooldownUntil: NOW + 3600_000, // active cooldown
      quota: [
        row({
          bucketId: "gemini-5h",
          remainingFraction: 0,
          resetAt: NOW + 3600_000,
        }),
      ],
    });

    const summary = toLeanPoolQuota([cooldownAcc], NOW);
    expect(summary.activeAccounts).toBe(1);
    expect(summary.gemini.available).toBe(false);
    expect(summary.gemini.remainingPercent).toBe(0);
    expect(summary.gemini.resetsIn).toBe("1h 0m");
  });

  it("considers accounts with unknown quota as not available if no account has quota", () => {
    const unknownAcc = makeAccount({
      id: "acc-free",
      quota: [], // free tier or summary read failure
    });

    const summary = toLeanPoolQuota([unknownAcc], NOW);
    expect(summary.activeAccounts).toBe(1);
    expect(summary.gemini.available).toBe(false);
    expect(summary.gemini.remainingPercent).toBe(0);
    expect(summary.gemini.resetsIn).toBeNull();
  });
});
