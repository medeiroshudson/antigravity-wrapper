import { describe, expect, it } from "vitest";
import {
  familyBucketPrefix,
  isEligibleForFamily,
  order,
  orderDecision,
  summarizeQuota,
} from "../src/lib/accounts/selector.js";
import type { AccountSnapshot, CooldownRow } from "../src/lib/accounts/store.js";
import { REAL_POOL, REAL_POOL_NOW } from "./fixtures/pool.js";

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
    cooldowns: [],
    ...over,
  };
}

function cooling(
  scope: string,
  kind = "quota",
  until: number = NOW + 1_000,
): CooldownRow {
  return { scope, kind, until, reason: null, failures: 1 };
}


function bucket(bucketId: string, remainingFraction: number, resetAt: number | null = null) {
  return {
    accountId: "x",
    bucketId,
    window: bucketId.endsWith("weekly") ? "weekly" : "5h",
    displayName: "Limit Remaining",
    groupName: bucketId.startsWith("gemini") ? "Gemini Models" : "Claude and GPT models",
    groupDescription: null,
    bucketDescription: null,
    remainingFraction,
    resetAt,
    fetchedAt: Date.now(),
  };
}

const NOW = 1_000_000;
const HOUR = 3_600_000;
const WEEK = 604_800_000;

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

  it("scores a non-oss GPT model by the 3p group, not as unknown", () => {
    const a = account({ id: "a", quota: [bucket("gemini-weekly", 0.9), bucket("3p-weekly", 0.4)] });
    // The backend's group is "Claude and GPT models", so the prefix must be `gpt-`, not
    // `gpt-oss-`. A narrower match would rank a future GPT model as unknown quota and
    // sort it last even when it is the only account with quota left.
    expect(summarizeQuota(a, "gpt-5-medium")).toBe(0.4);
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
        account({ id: "cooling", cooldowns: [cooling("*", "quota", NOW + 1_000)] }),
        account({ id: "expired", cooldowns: [cooling("*", "quota", NOW - 1_000)] }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["expired"]);
  });

  it("re-includes a cooldown that never recorded an expiration", () => {
    // `until` 0 is the row a failure count writes before the threshold benches it, and
    // the shape an old cooldown with no date became: treating it as binding would lose
    // the account forever.
    const result = order(
      [
        account({ id: "no-expiry", cooldowns: [cooling("*", "quota", 0)] }),
        account({ id: "cooling", cooldowns: [cooling("*", "quota", NOW + 1_000)] }),
      ],
      "m",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["no-expiry"]);
  });

  it("keeps an account benched on one family eligible for the other", () => {
    // Measured: a quota wall is per model family (gemini-* vs 3p-*). Benching the whole
    // account for a drained Claude quota took a fully-stocked Gemini quota out of service.
    const result = order(
      [
        account({
          id: "cooling",
          cooldowns: [cooling("3p-")],
          quota: [bucket("3p-5h", 0.5), bucket("gemini-5h", 1)],
        }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["cooling"]);
  });

  it("still discards an account benched on the family that failed", () => {
    const result = order(
      [
        account({
          id: "cooling",
          cooldowns: [cooling("3p-")],
          quota: [bucket("3p-5h", 0.5), bucket("gemini-5h", 1)],
        }),
      ],
      "claude-opus-4-6-thinking",
      NOW,
    );
    // The quota is positive, so only the cooldown can exclude it here.
    expect(result.map((a) => a.id)).toEqual([]);
  });

  it("keeps an account-wide cooldown binding on every family", () => {
    const result = order(
      [
        account({
          id: "cooling",
          cooldowns: [cooling("*", "quota", NOW + 1_000)],
          quota: [bucket("3p-5h", 1), bucket("gemini-5h", 1)],
        }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual([]);
  });

  it("binds only the account-wide cooldown when the requested family has no measurement", () => {
    // An unmeasured family (no bucket prefix) has no scope of its own, so a family
    // cooldown says nothing about it while `*` does.
    const familyOnly = account({ id: "family-only", cooldowns: [cooling("gemini-")] });
    expect(isEligibleForFamily(familyOnly, null, NOW)).toBe(true);

    const result = order(
      [account({ id: "cooling", cooldowns: [cooling("*", "quota", NOW + 1_000)] })],
      "llama-4-scout",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual([]);
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

  it("discards accounts with measured zero quota whose resetAt is in the future", () => {
    const result = order(
      [
        account({ id: "zerada", quota: [{ ...bucket("gemini-5h", 0), resetAt: NOW + 1000 }] }),
        account({ id: "com-cota", quota: [bucket("gemini-5h", 0.5)] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["com-cota"]);
  });

  it("keeps zero quota account if resetAt has already passed", () => {
    const result = order(
      [
        account({ id: "resetou", quota: [{ ...bucket("gemini-5h", 0), resetAt: NOW - 100 }] }),
        account({ id: "ativa", quota: [bucket("gemini-5h", 0.5)] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["ativa", "resetou"]);
  });

  it("places accounts with verified positive quota before unknown/free-tier quota", () => {
    const result = order(
      [
        account({ id: "free-sem-quota", quota: [] }),
        account({ id: "pro-com-quota", quota: [bucket("gemini-5h", 0.2)] }),
      ],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["pro-com-quota", "free-sem-quota"]);
  });

  it("places unknown quota after the known positive ones, without discarding", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "conhecida", quota: [bucket("gemini-5h", 0.3)] })],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["conhecida", "desconhecida"]);
  });

  it("discards zero quota account with no reset time or future reset time", () => {
    const result = order(
      [account({ id: "desconhecida" }), account({ id: "zerada", quota: [bucket("gemini-5h", 0)] })],
      "gemini-3.8-flash-high",
      NOW,
    );
    expect(result.map((a) => a.id)).toEqual(["desconhecida"]);
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
        account({ id: "cooling", cooldowns: [cooling("*", "quota", NOW + 1_000)] }),
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

describe("order — pace deficit", () => {
  it("ranks the real snapshot 492b -> 123e -> 9a15 (not by absolute remaining)", () => {
    // Replay of the measured pool (spec §4): 9a15 has the highest remaining fraction but
    // is ahead of its weekly pace, while 492b is behind on both of its Gemini windows.
    expect(order(REAL_POOL, "gemini-3.8-flash-high", REAL_POOL_NOW).map((a) => a.id)).toEqual([
      "account-492b954c1a93c92f",
      "account-123e90731bac6450",
      "account-9a15b1ef6fde541a",
    ]);
  });

  it("keeps priority above a better pace score", () => {
    const now = 10_000_000;
    const halfElapsed = now + 2.5 * HOUR;
    // Both windows are halfway through, so both accounts are scored. The priority-10
    // account is exactly on pace (remaining 0.5 => deficit 0) while the priority-0 account
    // is 0.30 behind (remaining 0.8 => deficit 0.30). Priority is the outer key, so the
    // worse score still wins and the tolerance band cannot promote the better-scoring one.
    const priority = account({
      id: "priority",
      priority: 10,
      quota: [bucket("gemini-5h", 0.5, halfElapsed)],
    });
    const bestScore = account({
      id: "best-score",
      quota: [bucket("gemini-5h", 0.8, halfElapsed)],
    });
    expect(
      order([bestScore, priority], "gemini-3.8-flash-high", now).map((entry) => entry.id),
    ).toEqual(["priority", "best-score"]);
  });

  it("scores an account by its tightest window in pace space", () => {
    const now = 10_000_000;
    // Both accounts end up with a score of 0.10, but through a different binding window:
    // A's 5h window is behind pace while B's weekly one is. The tie inside the tolerance
    // band is broken by least recent use, so B (1000) precedes A (2000).
    const a = account({
      id: "a",
      lastUsedAt: 2_000,
      quota: [
        // Half of the 5h window elapsed, 20% consumed => deficit 0.30.
        bucket("gemini-5h", 0.8, now + 2.5 * HOUR),
        // 11% of the weekly window elapsed, 1% consumed => deficit 0.10, the tightest one.
        bucket("gemini-weekly", 0.99, now + 0.89 * WEEK),
      ],
    });
    const b = account({
      id: "b",
      lastUsedAt: 1_000,
      quota: [
        // 20% of the 5h window elapsed, 10% consumed => deficit 0.10, the tightest one.
        bucket("gemini-5h", 0.9, now + 4 * HOUR),
        // 26% of the weekly window elapsed, 6% consumed => deficit 0.20.
        bucket("gemini-weekly", 0.94, now + 0.74 * WEEK),
      ],
    });
    expect(order([a, b], "gemini-3.8-flash-high", now).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("rotates accounts inside the tolerance band by oldest lastUsedAt", () => {
    const now = 10_000_000;
    const halfElapsed = now + 2.5 * HOUR;
    // A 0.30 and B 0.295 are inside the 0.02 band, so the older use wins: B (500) before
    // A (1000). C's 0.20 is outside the band and stays last even though it is the least
    // recently used: fairness must not let a clearly worse score jump the queue.
    const a = account({ id: "a", lastUsedAt: 1_000, quota: [bucket("gemini-5h", 0.8, halfElapsed)] });
    const b = account({ id: "b", lastUsedAt: 500, quota: [bucket("gemini-5h", 0.795, halfElapsed)] });
    const c = account({ id: "c", lastUsedAt: 0, quota: [bucket("gemini-5h", 0.7, halfElapsed)] });
    expect(order([a, b, c], "gemini-3.8-flash-high", now).map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  it("breaks a pace tie deterministically by lastUsedAt, then id", () => {
    const now = 10_000_000;
    const resetAt = now + 2.5 * HOUR;
    // Identical score and lastUsedAt: the id is the final key, so input order cannot leak
    // into the ranking through sort stability.
    const alpha = account({ id: "alpha", lastUsedAt: 500, quota: [bucket("gemini-5h", 0.8, resetAt)] });
    const beta = account({ id: "beta", lastUsedAt: 500, quota: [bucket("gemini-5h", 0.8, resetAt)] });
    expect(order([beta, alpha], "gemini-3.8-flash-high", now).map((entry) => entry.id)).toEqual(["alpha", "beta"]);
  });

  it("keeps the unscored fallback for buckets without resetAt", () => {
    const now = 10_000_000;
    // A bucket without resetAt cannot be normalized into pace space, so its account ranks
    // in the legacy tier below every scored account, even one with less absolute quota;
    // among unscored accounts the legacy quota-descending order is preserved.
    const scored = account({ id: "scored", quota: [bucket("gemini-5h", 0.6, now + 2.5 * HOUR)] });
    const freshUnscored = account({ id: "fresh-unscored", lastUsedAt: 900, quota: [bucket("gemini-5h", 0.99)] });
    const lowUnscored = account({ id: "low-unscored", lastUsedAt: 100, quota: [bucket("gemini-5h", 0.5)] });
    expect(order([freshUnscored, lowUnscored, scored], "gemini-3.8-flash-high", now).map((entry) => entry.id)).toEqual([
      "scored",
      "fresh-unscored",
      "low-unscored",
    ]);
  });
});

describe("isEligibleForFamily", () => {
  it("binds only the family the cooldown names", () => {
    const benched = account({
      id: "cooling",
      cooldowns: [cooling("3p-")],
      quota: [bucket("gemini-5h", 0.5)],
    });
    expect(isEligibleForFamily(benched, "gemini-", NOW)).toBe(true);
    expect(isEligibleForFamily(benched, "3p-", NOW)).toBe(false);
    // An unmeasured family has no scope of its own, so a family row says nothing about it.
    expect(isEligibleForFamily(benched, null, NOW)).toBe(true);
  });

  it("binds every family when the cooldown is account-wide", () => {
    const benched = account({
      id: "cooling",
      cooldowns: [cooling("*", "quota", NOW + 1_000)],
      quota: [bucket("gemini-5h", 0.5)],
    });
    expect(isEligibleForFamily(benched, "gemini-", NOW)).toBe(false);
    expect(isEligibleForFamily(benched, "3p-", NOW)).toBe(false);
    expect(isEligibleForFamily(benched, null, NOW)).toBe(false);
  });

  it("refuses an account whose project was never assigned, whatever its status says", () => {
    // `complete` inserts the account before Google assigns a project, so a row can read
    // `active` and enabled with `projectId` still null. It cannot build a request, so
    // admitting it only burns a failover slot — and, while `status` is `active`, it sorts
    // first among unknown-quota accounts, ahead of every account that can actually serve.
    const pending = account({ id: "pending", projectId: null });
    expect(isEligibleForFamily(pending, "gemini-", NOW)).toBe(false);
    expect(isEligibleForFamily(pending, null, NOW)).toBe(false);
    expect(
      order([pending, account({ id: "ready" })], "gemini-3.8-flash-high", NOW).map((entry) => entry.id),
    ).toEqual(["ready"]);
  });

  it("maps models to bucket prefixes", () => {
    expect(familyBucketPrefix("gemini-3.8-flash")).toBe("gemini-");
    expect(familyBucketPrefix("claude-opus-4-6-thinking")).toBe("3p-");
    expect(familyBucketPrefix("unknown-model")).toBeNull();
  });
});

describe("orderDecision — the single-eligible-account exception", () => {
  it("admits a lone account benched by a throttle and counts it", () => {
    // A throttle might already be over; a pool with nothing else to offer is better off
    // asking than reporting the pool empty.
    const throttled = account({
      id: "throttled",
      cooldowns: [cooling("gemini-", "transient_rate_limit", NOW + 30_000)],
      quota: [bucket("gemini-5h", 0.4)],
    });

    const decision = orderDecision([throttled], "gemini-3.8-flash-high", NOW);

    expect(decision.accounts.map((a) => a.id)).toEqual(["throttled"]);
    expect(decision.relaxed).toBe(1);
  });

  it("never relaxes a quota wall", () => {
    // Waiting politely does not refill a drained quota.
    const benched = account({
      id: "wall",
      cooldowns: [cooling("gemini-", "quota", NOW + 3_600_000)],
      quota: [bucket("gemini-5h", 0.4)],
    });

    const decision = orderDecision([benched], "gemini-3.8-flash-high", NOW);

    expect(decision.accounts).toEqual([]);
    expect(decision.relaxed).toBe(0);
  });

  it("does not relax while the normal pass can serve", () => {
    const open = account({ id: "open", quota: [bucket("gemini-5h", 0.5)] });
    const throttled = account({
      id: "throttled",
      cooldowns: [cooling("gemini-", "transient_rate_limit", NOW + 30_000)],
      quota: [bucket("gemini-5h", 0.9)],
    });

    const decision = orderDecision([throttled, open], "gemini-3.8-flash-high", NOW);

    expect(decision.accounts.map((a) => a.id)).toEqual(["open"]);
    expect(decision.relaxed).toBe(0);
  });

  it("does not relax an account excluded for another reason too", () => {
    // Zero quota waiting on its reset is not a throttle to be forgiven.
    const drained = account({
      id: "drained",
      cooldowns: [cooling("gemini-", "transient_rate_limit", NOW + 30_000)],
      quota: [{ ...bucket("gemini-5h", 0), resetAt: NOW + 1_000 }],
    });

    const decision = orderDecision([drained], "gemini-3.8-flash-high", NOW);

    expect(decision.accounts).toEqual([]);
    expect(decision.relaxed).toBe(0);
  });

  it("does not relax an account benched on another family", () => {
    const benched = account({
      id: "other-family",
      cooldowns: [cooling("3p-", "transient_rate_limit", NOW + 30_000)],
      quota: [bucket("gemini-5h", 0.4)],
    });

    const decision = orderDecision([benched], "gemini-3.8-flash-high", NOW);

    expect(decision.accounts.map((a) => a.id)).toEqual(["other-family"]);
    // It was never excluded here, so nothing was relaxed.
    expect(decision.relaxed).toBe(0);
  });

  it("keeps order() returning the plain list", () => {
    const open = account({ id: "open", quota: [bucket("gemini-5h", 0.5)] });
    expect(order([open], "gemini-3.8-flash-high", NOW).map((a) => a.id)).toEqual(["open"]);
  });
});
