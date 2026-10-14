import { describe, expect, it } from "vitest";
import { order, summarizeQuota } from "../src/lib/accounts/selector.js";
import type { AccountSnapshot } from "../src/lib/accounts/store.js";

function account(over: Partial<AccountSnapshot> & { id: string }): AccountSnapshot {
  return {
    email: `${over.id}@x.com`,
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
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

function bucket(bucketId: string, remainingFraction: number) {
  return {
    accountId: "x",
    bucketId,
    window: bucketId.endsWith("weekly") ? "weekly" : "5h",
    displayName: "Limit Remaining",
    groupName: bucketId.startsWith("gemini") ? "Gemini Models" : "Claude and GPT models",
    groupDescription: null,
    bucketDescription: null,
    remainingFraction,
    resetAt: null,
    fetchedAt: Date.now(),
  };
}

const NOW = 1_000_000;

describe("summarizeQuota", () => {
  it("scores a Gemini model by its group's tightest window", () => {
    const a = account({ id: "a", quota: [bucket("gemini-weekly", 0.9), bucket("gemini-5h", 0.2)] });
    // The tightest window is the binding constraint: a full 5h window is no help
    // when the weekly one is nearly spent.
    expect(summarizeQuota(a, "gemini-3.8-flash-high")).toBe(0.2);
  });

  it("ignores the other group's buckets", () => {
    const a = account({ id: "a", quota: [bucket("gemini-weekly", 0.9), bucket("3p-weekly", 0.1)] });
    // Otherwise one exhausted Claude quota would sink the Gemini models too.
    expect(summarizeQuota(a, "gemini-3.8-flash-high")).toBe(0.9);
  });

  it("scores Claude and GPT-OSS models by the 3p group", () => {
    const a = account({
      id: "a",
      quota: [bucket("gemini-5h", 0.01), bucket("3p-weekly", 0.8), bucket("3p-5h", 0.5)],
    });
    expect(summarizeQuota(a, "claude-opus-4-6-thinking")).toBe(0.5);
    expect(summarizeQuota(a, "gpt-oss-120b-medium")).toBe(0.5);
  });

  it("returns null when the requested group has no buckets at all", () => {
    const a = account({ id: "a", quota: [bucket("3p-weekly", 0.5)] });
    expect(summarizeQuota(a, "gemini-3.8-flash")).toBeNull();
  });

  it("returns null for a model family with no known group", () => {
    const a = account({ id: "a", quota: [bucket("gemini-weekly", 0.5), bucket("3p-weekly", 0.5)] });
    // A future family must score as unknown, never as 0 (which would sink the
    // account) nor as 1 (which would make it win).
    expect(summarizeQuota(a, "llama-4-scout")).toBeNull();
  });

  it("returns null for an account with no quota at all", () => {
    expect(summarizeQuota(account({ id: "a" }), "gemini-3.8-flash")).toBeNull();
  });
});

describe("order", () => {
  it("discards disabled and invalid accounts", () => {
    const result = order(
      [account({ id: "a" }), account({ id: "b", enabled: false }), account({ id: "c", status: "invalid" })],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });

  it("discards an active cooldown and re-includes an expired one", () => {
    const result = order(
      [
        account({ id: "cooling", status: "cooldown", cooldownUntil: NOW + 1000 }),
        account({ id: "expired", status: "cooldown", cooldownUntil: NOW - 1000 }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["expired"]);
  });

  it("re-includes a cooldown without a recorded expiration", () => {
    const result = order(
      [
        account({ id: "no-expiry", status: "cooldown", cooldownUntil: null }),
        account({ id: "cooling", status: "cooldown", cooldownUntil: NOW + 1000 }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["no-expiry"]);
  });

  it("orders by remaining quota descending", () => {
    const result = order(
      [
        account({ id: "meio", quota: [bucket("gemini-5h", 0.5)] }),
        account({ id: "cheio", quota: [bucket("gemini-5h", 1)] }),
        account({ id: "baixo", quota: [bucket("gemini-5h", 0.1)] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["cheio", "meio", "baixo"]);
  });

  it("places unknown quota after the known ones, without discarding", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "conhecida", quota: [bucket("gemini-5h", 0.3)] })],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["conhecida", "desconhecida"]);
  });

  it("keeps unknown quota after a known quota equal to zero", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "zerada", quota: [bucket("gemini-5h", 0)] })],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["zerada", "desconhecida"]);
  });

  it("breaks ties by the oldest lastUsedAt", () => {
    const result = order(
      [
        account({ id: "recente", quota: [bucket("gemini-5h", 0.5)], lastUsedAt: NOW - 10 }),
        account({ id: "antiga", quota: [bucket("gemini-5h", 0.5)], lastUsedAt: NOW - 10_000 }),
        account({ id: "nunca", quota: [bucket("gemini-5h", 0.5)], lastUsedAt: null }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["nunca", "antiga", "recente"]);
  });

  it("considers priority before quota", () => {
    const result = order(
      [account({ id: "normal", quota: [bucket("gemini-5h", 1)] }), account({ id: "alta", priority: 10, quota: [bucket("gemini-5h", 0.1)] })],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["alta", "normal"]);
  });

  it("returns an empty list when nothing is eligible", () => {
    expect(order([account({ id: "a", enabled: false })], "m", NOW)).toEqual([]);
  });

  it("ranks an account with a measured quota above one with none", () => {
    const result = order(
      [
        account({ id: "sem-grupos" }),
        account({ id: "medida", quota: [bucket("gemini-weekly", 0.97), bucket("gemini-5h", 0.97)] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    // A free-tier account reports 1.0 per model yet has no summary (spec §3.5). It must
    // rank last rather than win on a number that measures nothing.
    expect(result.map((a) => a.id)).toEqual(["medida", "sem-grupos"]);
  });

  it("keeps the account with no groups eligible rather than dropping it", () => {
    const result = order(
      [
        account({ id: "sem-grupos" }),
        account({ id: "cooling", status: "cooldown", cooldownUntil: NOW + 1000 }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["sem-grupos"]);
  });

  it("lets priority override a measured quota", () => {
    const result = order(
      [
        account({ id: "medida", quota: [bucket("gemini-weekly", 1)] }),
        account({ id: "gratuita", priority: 10, quota: [] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["gratuita", "medida"]);
  });
});
