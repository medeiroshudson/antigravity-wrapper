import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../src/lib/accounts/service.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { TurnRunner } from "../src/lib/chat/turn.js";
import { UpstreamError } from "../src/lib/antigravity/errors.js";
import { getPublicModels, resetDiscoveredModelsForTests } from "../src/config/models.js";

const ENV = { ANTIGRAVITY_CLIENT_ID: "cid", ANTIGRAVITY_CLIENT_SECRET: "sec" };
let dir: string;
let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agw-svc-"));
  store = new AccountStore(join(dir, "t.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  resetDiscoveredModelsForTests();
});

function seed(id = "a1", over: { accessExpiresAt?: number } = {}) {
  return store.upsertAccount({
    id,
    email: `${id}@x.com`,
    refreshToken: `r-${id}`,
    accessToken: `a-${id}`,
    accessExpiresAt: over.accessExpiresAt ?? Date.now() + 3_600_000,
    projectId: "p",
  });
}

describe("ensureFresh", () => {
  it("returns the account without touching the network when the token is still valid", async () => {
    seed();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    const account = await service.ensureFresh(store.getAccount("a1")!);
    expect(account.accessToken).toBe("a-a1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renews and persists when the token is expiring", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "novo", expires_in: 3600 })),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    const account = await service.ensureFresh(store.getAccount("a1")!);
    expect(account.accessToken).toBe("novo");
    expect(store.getAccount("a1")?.accessToken).toBe("novo");
  });
});

describe("applyFailure", () => {
  it("puts it on cooldown until resetTime on a quota wall", () => {
    seed();
    // 7_200_000 differs from the getCooldownTransientMs default (60_000): if the
    // implementation ignored retryAfterMs, cooldownUntil would be ~60s ahead and
    // the assertion below would fail.
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("quota", 429, "quota", 7_200_000));
    const account = store.getAccount("a1");
    expect(account?.status).toBe("cooldown");
    expect(account?.cooldownUntil).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it("leaves the state unchanged on a transient 429 (spec §11)", () => {
    seed();
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("transient_rate_limit", 429, "rl"));
    const account = store.getAccount("a1");
    // The spec's error table says a transient throttle changes nothing in the pool.
    // Cooling the account down instead took it out of rotation for the whole
    // cooldown window, so every later request answered 503 while the quota was
    // still almost untouched.
    expect(account?.status).toBe("active");
    expect(account?.cooldownUntil).toBeNull();
  });

  it("marks it invalid on VALIDATION_REQUIRED, storing the reason", () => {
    seed();
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("validation_required", 403, "verify"));
    expect(store.getAccount("a1")?.status).toBe("invalid");
    expect(store.getAccount("a1")?.lastError).toMatch(/browser verification/i);
  });

  it("marks it invalid on an authentication error", () => {
    seed();
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("auth", 401, "expired"));
    expect(store.getAccount("a1")?.status).toBe("invalid");
  });

  it("does not change the state on a 403 license error (wrapper failure, not the account's)", () => {
    seed();
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("license", 403, "no license"));
    expect(store.getAccount("a1")?.status).toBe("active");
  });

  it("does not change the state on a client error", () => {
    seed();
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("client_error", 400, "bad"));
    expect(store.getAccount("a1")?.status).toBe("active");
  });
});

describe("orderFor", () => {
  it("returns the candidates ordered", async () => {
    seed("a1");
    seed("a2");
    const service = new AccountService({ store, env: ENV });
    expect(await service.orderFor("gemini-3.8-flash-low")).toHaveLength(2);
  });

  it("returns an empty list when nothing is eligible", async () => {
    seed("a1");
    store.setEnabled("a1", false);
    const service = new AccountService({ store, env: ENV });
    expect(await service.orderFor("m")).toEqual([]);
  });

  it("markUsed records the use", async () => {
    seed("a1");
    const service = new AccountService({ store, env: ENV });
    service.markUsed("a1");
    expect(store.getAccount("a1")?.lastUsedAt).not.toBeNull();
  });
});

describe("refreshQuota", () => {
  const SUMMARY = {
    groups: [
      {
        displayName: "Gemini Models",
        description: "Models within this group: Gemini Flash, Gemini Pro",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-10-19T20:43:54Z",
            remainingFraction: 0.99093425,
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            resetTime: "2026-10-14T03:07:40Z",
            remainingFraction: 0.9883959,
          },
        ],
      },
    ],
  };

  const CATALOG = {
    models: {
      "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.5 } },
      "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.5 } },
    },
  };

  /** Answers the catalog, the summary and the tier from one stub, in any order. */
  function upstream(
    opts: {
      catalog?: unknown;
      catalogStatus?: number;
      summary?: unknown;
      summaryStatus?: number;
      codeAssist?: unknown;
      codeAssistStatus?: number;
    } = {},
  ) {
    const tier = {
      cloudaicompanionProject: "p",
      paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
    };
    return vi.fn(async (url: string) => {
      if (url.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify(opts.catalog ?? CATALOG), {
          status: opts.catalogStatus ?? 200,
        });
      }
      if (url.includes("loadCodeAssist")) {
        return new Response(JSON.stringify(opts.codeAssist ?? tier), {
          status: opts.codeAssistStatus ?? 200,
        });
      }
      return new Response(JSON.stringify(opts.summary ?? SUMMARY), {
        status: opts.summaryStatus ?? 200,
      });
    }) as unknown as typeof fetch;
  }

  it("stores the summary buckets under the account", async () => {
    seed();
    const service = new AccountService({ store, env: ENV, fetchImpl: upstream() });
    await service.refreshQuota("a1");

    const quota = store.getQuota("a1");
    expect(quota.map((row) => row.bucketId)).toEqual(["gemini-weekly", "gemini-5h"]);
    expect(quota[0]?.accountId).toBe("a1");
    expect(quota[0]?.groupName).toBe("Gemini Models");
    expect(quota[1]?.remainingFraction).toBe(0.9883959);
    expect(store.getAccount("a1")?.quotaSummaryError).toBeNull();
    // token still valid: it must not renew
    expect(store.getAccount("a1")?.accessToken).toBe("a-a1");
  });

  it("stores the tier alongside the quota", async () => {
    seed();
    await new AccountService({ store, env: ENV, fetchImpl: upstream() }).refreshQuota("a1");

    // One cycle, so the tier and the quota are as of the same moment (spec D14).
    expect(store.getAccount("a1")?.paidTierId).toBe("g1-pro-tier");
    expect(store.getAccount("a1")?.paidTierName).toBe("Google AI Pro");
  });

  it("stores the free tier and the 403 in the same cycle", async () => {
    seed();
    const subscription403 = {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "You do not have a valid license of this product. (#3501)",
        details: [{ reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" }],
      },
    };
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({
        summary: subscription403,
        summaryStatus: 403,
        codeAssist: {
          cloudaicompanionProject: "p",
          paidTier: { id: "free-tier", name: "Antigravity Starter Quota" },
        },
      }),
    }).refreshQuota("a1");

    const account = store.getAccount("a1");
    // This is the whole point of D14+D15: the operator sees which tier and why there
    // are no groups on the same row (spec §9.1).
    expect(account?.paidTierId).toBe("free-tier");
    expect(account?.quotaSummaryError).toContain("paid subscription");
    expect(store.getQuota("a1")).toEqual([]);
  });

  it("leaves the stored tier alone when the tier read fails", async () => {
    seed();
    store.setPaidTier("a1", { id: "g1-pro-tier", name: "Google AI Pro" });

    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({ codeAssist: { error: { message: "boom" } }, codeAssistStatus: 500 }),
    }).refreshQuota("a1");

    // A transient failure must not blank the display (spec §13): the previous tier is
    // still the best thing we know, and the quota refresh succeeded independently.
    expect(store.getAccount("a1")?.paidTierId).toBe("g1-pro-tier");
    expect(store.getQuota("a1")).toHaveLength(2);
  });

  it("still records the quota when only the tier read fails", async () => {
    seed();
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({ codeAssistStatus: 500 }),
    }).refreshQuota("a1");

    // The two reads are independent: one failing must not cancel the other.
    expect(store.getQuota("a1")).toHaveLength(2);
    expect(store.getAccount("a1")?.paidTierId).toBeNull();
  });

  it("still feeds the model catalog from fetchAvailableModels", async () => {
    seed();
    await new AccountService({ store, env: ENV, fetchImpl: upstream() }).refreshQuota("a1");
    const ids = getPublicModels().map((model) => model.id);
    // The catalog keeps coming from fetchAvailableModels: it is the only source of
    // model ids (spec §6).
    expect(ids).toContain("claude-opus-4-6-thinking");
    // The static table remains: discovery is additive.
    expect(ids).toContain("gemini-3.8-flash");
  });

  it("records a subscription failure without touching the account state", async () => {
    seed();
    const subscription403 = {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "You do not have a valid license of this product. (#3501)",
        details: [{ reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" }],
      },
    };
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({ summary: subscription403, summaryStatus: 403 }),
    }).refreshQuota("a1");

    const account = store.getAccount("a1");
    expect(account?.quotaSummaryError).toContain("paid subscription");
    // The measured behaviour: this account still serves requests (spec §3.5). Nothing
    // about the account itself may change, or an operator would remove a working one.
    expect(account?.status).toBe("active");
    expect(account?.cooldownUntil).toBeNull();
    expect(account?.enabled).toBe(true);
    expect(store.getQuota("a1")).toEqual([]);
  });

  it("clears the error once a later refresh succeeds", async () => {
    seed();
    store.setQuotaSummaryError("a1", "stale reason");
    await new AccountService({ store, env: ENV, fetchImpl: upstream() }).refreshQuota("a1");
    expect(store.getAccount("a1")?.quotaSummaryError).toBeNull();
  });

  it("clears stale buckets when the summary fails", async () => {
    seed();
    store.replaceQuota("a1", [
      {
        bucketId: "gemini-weekly",
        window: "weekly",
        displayName: null,
        groupName: "Gemini Models",
        groupDescription: null,
        bucketDescription: null,
        remainingFraction: 0.5,
        resetAt: null,
        fetchedAt: 1,
      },
    ]);
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({ summary: { error: { message: "boom" } }, summaryStatus: 500 }),
    }).refreshQuota("a1");

    // The reading is "as of fetchedAt"; keeping a row the refresh could not confirm
    // would report a quota the account may not have (spec §11).
    expect(store.getQuota("a1")).toEqual([]);
    expect(store.getAccount("a1")?.quotaSummaryError).toContain("boom");
  });

  it("does not overwrite the catalog when the catalog read fails", async () => {
    seed();
    await new AccountService({ store, env: ENV, fetchImpl: upstream() }).refreshQuota("a1");
    const before = getPublicModels().map((model) => model.id);
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({ catalogStatus: 500 }),
    }).refreshQuota("a1");
    expect(getPublicModels().map((model) => model.id)).toEqual(before);
  });

  it("renews the token before reading the catalog, the summary and the tier", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });

    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "novo", expires_in: 3600 }));
      }
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      // Every call must carry the renewed token, not the expired one.
      expect(authorization).toBe("Bearer novo");
      if (url.includes("fetchAvailableModels")) return new Response(JSON.stringify(CATALOG));
      if (url.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({ cloudaicompanionProject: "p", paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }),
        );
      }
      return new Response(JSON.stringify(SUMMARY));
    }) as unknown as typeof fetch;

    await new AccountService({ store, env: ENV, fetchImpl }).refreshQuota("a1");

    expect(store.getAccount("a1")?.accessToken).toBe("novo");
    expect(urls.some((url) => url.includes("retrieveUserQuotaSummary"))).toBe(true);
    expect(urls.some((url) => url.includes("loadCodeAssist"))).toBe(true);
  });
});

describe("failover when the token refresh fails", () => {
  function sseResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ola"}]}}]}}\n\n' +
              'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("moves to the next account and marks the first as invalid", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 }); // forces the refresh, which will fail
    seed("a2"); // valid token
    store.setPriority("a1", 10); // ensures a1 is tried first
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.href;
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      return sseResponse();
    }) as unknown as typeof fetch;
    const accounts = new AccountService({ store, env: ENV, fetchImpl });
    const runner = new TurnRunner({ accounts, fetchImpl, env: ENV });
    const { accountId, result } = await runner.run({
      runtimeModel: "gemini-3.8-flash-low",
      contents: [{ role: "user", parts: [{ text: "oi" }] }],
      systemInstruction: "sys",
      effort: "off",
    });
    expect(accountId).toBe("a2");
    expect(result.content).toBe("ola");
    expect(store.getAccount("a1")?.status).toBe("invalid");
  });
});
