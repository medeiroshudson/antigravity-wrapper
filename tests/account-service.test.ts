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
  const catalog = {
    models: {
      "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-19T20:39:33Z" } },
    },
  };

  it("stores the quota snapshot with the correct accountId", async () => {
    seed();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog))) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    await service.refreshQuota("a1");
    const quota = store.getQuota("a1");
    expect(quota).toHaveLength(1);
    expect(quota[0]?.accountId).toBe("a1");
    expect(quota[0]?.modelId).toBe("gemini-3.8-flash-low");
    expect(quota[0]?.remainingFraction).toBe(0.5);
    // token still valid: it must not renew
    expect(store.getAccount("a1")?.accessToken).toBe("a-a1");
  });

  it("renews the token before reading the quota when it is expiring", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.href;
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "novo", expires_in: 3600 }));
      }
      return new Response(JSON.stringify(catalog));
    }) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    await service.refreshQuota("a1");
    expect(store.getAccount("a1")?.accessToken).toBe("novo");
    expect(store.getQuota("a1")).toHaveLength(1);
  });

  it("feeds the public model catalog with what was discovered", async () => {
    seed();
    const fetched = {
      models: { "claude-opus-4-6": { quotaInfo: { remainingFraction: 1 } } },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fetched))) as unknown as typeof fetch;
    await new AccountService({ store, env: ENV, fetchImpl }).refreshQuota("a1");
    const ids = getPublicModels().map((model) => model.id);
    expect(ids).toContain("claude-opus-4-6");
    // The static table remains: discovery is additive.
    expect(ids).toContain("gemini-3.8-flash");
  });

  it("a failed discovery does not wipe the catalog (neither the static nor the already-discovered one)", async () => {
    seed();
    const ok = vi.fn(
      async () =>
        new Response(JSON.stringify({ models: { "claude-opus-4-6": { quotaInfo: { remainingFraction: 1 } } } })),
    ) as unknown as typeof fetch;
    await new AccountService({ store, env: ENV, fetchImpl: ok }).refreshQuota("a1");
    expect(getPublicModels().map((model) => model.id)).toContain("claude-opus-4-6");

    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await new AccountService({ store, env: ENV, fetchImpl: failing }).refreshQuota("a1");
    const ids = getPublicModels().map((model) => model.id);
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("gemini-3.8-flash");
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
