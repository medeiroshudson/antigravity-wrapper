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

function quota(remainingFraction: number, modelId = "m") {
  return { accountId: "x", modelId, window: "5h", remainingFraction, resetAt: null, fetchedAt: Date.now() };
}

const NOW = 1_000_000;

describe("summarizeQuota", () => {
  it("returns the lowest fraction across the model's windows", () => {
    const a = account({ id: "a", quota: [quota(0.9), { ...quota(0.2), window: "weekly" }] });
    expect(summarizeQuota(a, "m")).toBe(0.2);
  });

  it("returns null when there is no known quota for the model", () => {
    expect(summarizeQuota(account({ id: "a", quota: [quota(1, "outro")] }), "m")).toBeNull();
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
        account({ id: "meio", quota: [quota(0.5)] }),
        account({ id: "cheio", quota: [quota(1)] }),
        account({ id: "baixo", quota: [quota(0.1)] }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["cheio", "meio", "baixo"]);
  });

  it("places unknown quota after the known ones, without discarding", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "conhecida", quota: [quota(0.3)] })],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["conhecida", "desconhecida"]);
  });

  it("keeps unknown quota after a known quota equal to zero", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "zerada", quota: [quota(0)] })],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["zerada", "desconhecida"]);
  });

  it("breaks ties by the oldest lastUsedAt", () => {
    const result = order(
      [
        account({ id: "recente", quota: [quota(0.5)], lastUsedAt: NOW - 10 }),
        account({ id: "antiga", quota: [quota(0.5)], lastUsedAt: NOW - 10_000 }),
        account({ id: "nunca", quota: [quota(0.5)], lastUsedAt: null }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["nunca", "antiga", "recente"]);
  });

  it("considers priority before quota", () => {
    const result = order(
      [account({ id: "normal", quota: [quota(1)] }), account({ id: "alta", priority: 10, quota: [quota(0.1)] })],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["alta", "normal"]);
  });

  it("returns an empty list when nothing is eligible", () => {
    expect(order([account({ id: "a", enabled: false })], "m", NOW)).toEqual([]);
  });
});
