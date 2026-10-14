import { describe, expect, it } from "vitest";
import type { QuotaBucket } from "../src/lib/accounts/store.js";
import { toGroupsView } from "../src/lib/format/quota.js";

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
