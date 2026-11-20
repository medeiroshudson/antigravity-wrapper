import { describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../src/lib/accounts/store.js";
import { byLastUseThenId } from "../src/lib/accounts/strategies/comparators.js";
import { LeastBusyStrategy } from "../src/lib/accounts/strategies/least-busy.js";
import { PriorityTieredStrategy } from "../src/lib/accounts/strategies/priority-tiered.js";
import { QuotaFirstStrategy } from "../src/lib/accounts/strategies/quota-first.js";
import { RoundRobinStrategy } from "../src/lib/accounts/strategies/round-robin.js";
import { createStrategy } from "../src/lib/accounts/strategies/registry.js";
import type { EligibleCandidate, SelectionContext } from "../src/lib/accounts/strategies/types.js";
import { WeightedRandomStrategy } from "../src/lib/accounts/strategies/weighted-random.js";

function account(over: Partial<AccountSnapshot> & { id: string }): AccountSnapshot {
  return {
    email: `${over.id}@x.com`,
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: 1_000_000 + 3_600_000,
    projectId: "p",
    status: "active",
    statusKind: null,
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

function candidate(
  id: string,
  quota: number | null,
  score: number | null = null,
  over: Partial<AccountSnapshot> = {},
): EligibleCandidate {
  return { account: account({ id, ...over }), quota, score };
}

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    runtimeModel: "gemini-3.8-flash-high",
    bucketIdPrefix: "gemini-",
    now: 1_000_000,
    ...over,
  };
}

function ids(accounts: readonly AccountSnapshot[]): string[] {
  return accounts.map((item) => item.id);
}

/** Deterministic PRNG (mulberry32): each seed gives a well-spread repeatable sequence. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("byLastUseThenId", () => {
  it("sorts oldest use first, counting never-used as 0", () => {
    const never = candidate("never", null, null, { lastUsedAt: null });
    const recent = candidate("recent", null, null, { lastUsedAt: 500 });
    expect(byLastUseThenId(never, recent)).toBeLessThan(0);
    expect(byLastUseThenId(recent, never)).toBeGreaterThan(0);
  });

  it("breaks equal last use by ascending id", () => {
    const a = candidate("a", null, null, { lastUsedAt: 10 });
    const b = candidate("b", null, null, { lastUsedAt: 10 });
    expect(byLastUseThenId(a, b)).toBeLessThan(0);
    expect(byLastUseThenId(b, a)).toBeGreaterThan(0);
    expect(byLastUseThenId(a, a)).toBe(0);
  });
});

describe("QuotaFirstStrategy", () => {
  const strategy = new QuotaFirstStrategy();

  it("orders known positive quota descending", () => {
    const ranked = strategy.rank(
      [candidate("low", 0.2), candidate("high", 0.9), candidate("mid", 0.5)],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["high", "mid", "low"]);
  });

  it("breaks equal quota by least recent use, then id", () => {
    const ranked = strategy.rank(
      [
        candidate("z-recent", 0.9, null, { lastUsedAt: 900 }),
        candidate("b-old", 0.9, null, { lastUsedAt: 100 }),
        candidate("a-old", 0.9, null, { lastUsedAt: 100 }),
      ],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["a-old", "b-old", "z-recent"]);
  });

  it("places unknown quota after positive and before zero", () => {
    const ranked = strategy.rank(
      [candidate("zero", 0), candidate("unknown", null), candidate("positive", 0.1)],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["positive", "unknown", "zero"]);
  });

  it("puts zero and negative quota last, ordered by use not by value", () => {
    const ranked = strategy.rank(
      [
        candidate("negative", -0.5, null, { lastUsedAt: 1 }),
        candidate("zero-recent", 0, null, { lastUsedAt: 900 }),
        candidate("zero-old", 0, null, { lastUsedAt: 100 }),
      ],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["negative", "zero-old", "zero-recent"]);
  });

  it("ignores the pace score entirely", () => {
    const ranked = strategy.rank([candidate("scored", 0.2, 0.5), candidate("unscored", 0.8, null)], ctx());
    expect(ids(ranked)).toEqual(["unscored", "scored"]);
  });

  it("drops nothing and leaves the input untouched", () => {
    const input = [candidate("b", 0.2), candidate("a", 0.9), candidate("c", null)];
    const ranked = strategy.rank(input, ctx());
    expect(ranked).toHaveLength(3);
    expect(input.map((item) => item.account.id)).toEqual(["b", "a", "c"]);
  });

  it("returns an empty list for no candidates", () => {
    expect(strategy.rank([], ctx())).toEqual([]);
  });
});

describe("LeastBusyStrategy", () => {
  const strategy = new LeastBusyStrategy();

  it("prefers the account with fewer in-flight requests", () => {
    const ranked = strategy.rank(
      [candidate("busy", 1), candidate("idle", 0.1), candidate("half", 1)],
      ctx({ inFlightByAccount: new Map([["busy", 5], ["half", 2]]) }),
    );
    expect(ids(ranked)).toEqual(["idle", "half", "busy"]);
  });

  it("treats a missing in-flight entry as zero", () => {
    const ranked = strategy.rank(
      [candidate("counted", 1), candidate("missing", 0.1)],
      ctx({ inFlightByAccount: new Map([["counted", 1]]) }),
    );
    expect(ids(ranked)).toEqual(["missing", "counted"]);
  });

  it("works without an in-flight map at all", () => {
    const ranked = strategy.rank([candidate("b", 1), candidate("a", 1)], ctx());
    expect(ids(ranked)).toEqual(["a", "b"]);
  });

  it("breaks equal load by pace score descending", () => {
    const ranked = strategy.rank(
      [candidate("cold", 0.5, 0.1), candidate("hot", 0.5, 0.4)],
      ctx({ inFlightByAccount: new Map([["cold", 1], ["hot", 1]]) }),
    );
    expect(ids(ranked)).toEqual(["hot", "cold"]);
  });

  it("falls back to least recent use when a score is not finite", () => {
    const ranked = strategy.rank(
      [
        candidate("nan-recent", 0.5, Number.NaN, { lastUsedAt: 900 }),
        candidate("scored-old", 0.5, 0.4, { lastUsedAt: 100 }),
      ],
      ctx({ inFlightByAccount: new Map([["nan-recent", 1], ["scored-old", 1]]) }),
    );
    expect(ids(ranked)).toEqual(["scored-old", "nan-recent"]);
  });

  it("falls back to least recent use when both scores are null", () => {
    const ranked = strategy.rank(
      [
        candidate("recent", 0.5, null, { lastUsedAt: 900 }),
        candidate("old", 0.5, null, { lastUsedAt: 100 }),
      ],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["old", "recent"]);
  });

  it("keeps the input order untouched", () => {
    const input = [candidate("b", 1), candidate("a", 1)];
    strategy.rank(input, ctx());
    expect(input.map((item) => item.account.id)).toEqual(["b", "a"]);
  });
});

describe("RoundRobinStrategy", () => {
  it("rotates through the pool in id order", () => {
    const strategy = new RoundRobinStrategy();
    const pool = [candidate("c", null), candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["a", "b", "c"]);
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["b", "c", "a"]);
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["c", "a", "b"]);
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["a", "b", "c"]);
  });

  it("keeps one cursor per model family", () => {
    const strategy = new RoundRobinStrategy();
    const pool = [candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx({ bucketIdPrefix: "gemini-" })))).toEqual(["a", "b"]);
    expect(ids(strategy.rank(pool, ctx({ bucketIdPrefix: "3p-", runtimeModel: "claude-opus-4-6" })))).toEqual([
      "a",
      "b",
    ]);
    expect(ids(strategy.rank(pool, ctx({ bucketIdPrefix: "gemini-" })))).toEqual(["b", "a"]);
  });

  it("uses the wildcard cursor for an unmeasured family", () => {
    const strategy = new RoundRobinStrategy();
    const pool = [candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx({ bucketIdPrefix: null })))).toEqual(["a", "b"]);
    expect(ids(strategy.rank(pool, ctx({ bucketIdPrefix: null })))).toEqual(["b", "a"]);
  });

  it("returns an empty list and keeps the cursor for an empty pool", () => {
    const strategy = new RoundRobinStrategy();
    expect(strategy.rank([], ctx())).toEqual([]);
    const pool = [candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["a", "b"]);
  });

  it("wraps a cursor left over from a larger pool", () => {
    const strategy = new RoundRobinStrategy();
    const large = [candidate("a", null), candidate("b", null), candidate("c", null)];
    strategy.rank(large, ctx());
    strategy.rank(large, ctx());
    strategy.rank(large, ctx());
    // Cursor is 3 here; the two-account pool wraps it modulo its own size.
    expect(ids(strategy.rank([candidate("a", null), candidate("b", null)], ctx()))).toEqual(["b", "a"]);
  });

  it("returns every candidate exactly once", () => {
    const strategy = new RoundRobinStrategy();
    const pool = [candidate("c", null), candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx())).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("WeightedRandomStrategy", () => {
  it("is deterministic for a given random source", () => {
    const pool = [candidate("a", 0.5), candidate("b", 0.2), candidate("c", 0.9)];
    const left = new WeightedRandomStrategy(seeded(42)).rank(pool, ctx());
    const right = new WeightedRandomStrategy(seeded(42)).rank(pool, ctx());
    expect(ids(left)).toEqual(ids(right));
  });

  it("returns every candidate exactly once", () => {
    const pool = [candidate("a", 0.5), candidate("b", 0), candidate("c", null), candidate("d", -1)];
    const ranked = new WeightedRandomStrategy(seeded(7)).rank(pool, ctx());
    expect(ids(ranked).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("picks the larger quota first most of the time", () => {
    const pool = [candidate("heavy", 0.9), candidate("light", 0.1)];
    let heavyFirst = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const ranked = new WeightedRandomStrategy(seeded(seed)).rank(pool, ctx());
      if (ranked[0]?.id === "heavy") heavyFirst += 1;
    }
    expect(heavyFirst).toBeGreaterThan(150);
  });

  it("still gives zero and unknown quota a small chance", () => {
    const pool = [candidate("real", 1), candidate("zero", 0), candidate("unknown", null)];
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const ranked = new WeightedRandomStrategy(seeded(seed)).rank(pool, ctx());
      firsts.add(ranked[0]?.id ?? "");
    }
    expect(firsts).toEqual(new Set(["real", "zero", "unknown"]));
  });

  it("returns a single candidate unchanged", () => {
    expect(ids(new WeightedRandomStrategy(seeded(1)).rank([candidate("only", 0.3)], ctx()))).toEqual(["only"]);
  });

  it("returns an empty list for no candidates", () => {
    expect(new WeightedRandomStrategy(seeded(1)).rank([], ctx())).toEqual([]);
  });

  it("defaults to Math.random without throwing", () => {
    const ranked = new WeightedRandomStrategy().rank([candidate("a", 0.5), candidate("b", 0.5)], ctx());
    expect(ids(ranked).sort()).toEqual(["a", "b"]);
  });
});

describe("PriorityTieredStrategy", () => {
  it("puts the higher priority first even with worse inner ranks", () => {
    const strategy = new PriorityTieredStrategy(new QuotaFirstStrategy());
    const ranked = strategy.rank(
      [candidate("bulk", 1), candidate("vip", 0.1, null, { priority: 10 })],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["vip", "bulk"]);
  });

  it("delegates each tier to the inner strategy", () => {
    const strategy = new PriorityTieredStrategy(new QuotaFirstStrategy());
    const ranked = strategy.rank(
      [
        candidate("vip-low", 0.1, null, { priority: 5 }),
        candidate("vip-high", 0.9, null, { priority: 5 }),
        candidate("normal-high", 1, null, { priority: 0 }),
      ],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["vip-high", "vip-low", "normal-high"]);
  });

  it("sorts priority levels numerically, highest first", () => {
    const strategy = new PriorityTieredStrategy(new QuotaFirstStrategy());
    const ranked = strategy.rank(
      [
        candidate("zero", 0, null, { priority: 0 }),
        candidate("minus", 0, null, { priority: -5 }),
        candidate("ten", 0, null, { priority: 10 }),
      ],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["ten", "zero", "minus"]);
  });

  it("reports the inner strategy's name", () => {
    expect(new PriorityTieredStrategy(new QuotaFirstStrategy()).name).toBe("quota-first");
  });

  it("returns an empty list for no candidates", () => {
    expect(new PriorityTieredStrategy(new QuotaFirstStrategy()).rank([], ctx())).toEqual([]);
  });
});

describe("createStrategy", () => {
  it("builds every strategy by name", () => {
    const names = ["pace-deficit", "quota-first", "least-busy", "round-robin", "weighted-random"] as const;
    for (const name of names) {
      expect(createStrategy(name).name).toBe(name);
      expect(createStrategy(name, { respectPriority: false }).name).toBe(name);
    }
  });

  it("honours priority by default", () => {
    const ranked = createStrategy("quota-first").rank(
      [candidate("bulk", 1), candidate("vip", 0.1, null, { priority: 10 })],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["vip", "bulk"]);
  });

  it("drops the priority tier when respectPriority is false", () => {
    const ranked = createStrategy("quota-first", { respectPriority: false }).rank(
      [candidate("bulk", 1), candidate("vip", 0.1, null, { priority: 10 })],
      ctx(),
    );
    expect(ids(ranked)).toEqual(["bulk", "vip"]);
  });

  it("keeps round-robin rotating behind the priority wrapper", () => {
    const strategy = createStrategy("round-robin");
    const pool = [candidate("a", null), candidate("b", null)];
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["a", "b"]);
    expect(ids(strategy.rank(pool, ctx()))).toEqual(["b", "a"]);
  });
});
