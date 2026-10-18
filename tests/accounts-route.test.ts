import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { resetRegistryForTests } from "../src/config/models.js";
import { AccountStore } from "../src/lib/accounts/store.js";

const auth = { authorization: "Bearer test-key" };
const ENV = { ANTIGRAVITY_CLIENT_ID: "cid", ANTIGRAVITY_CLIENT_SECRET: "sec" };
let app: FastifyInstance;
let store: AccountStore;

beforeEach(() => {
  store = new AccountStore(":memory:");
  // The model registry is module-level state shared across the file: reset it so a test
  // that seeds a catalog cannot leak into another (and vice versa).
  resetRegistryForTests();
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe("POST /admin/accounts/start", () => {
  it("returns authUrl and state, and stores the verifier", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const response = await app.inject({ method: "POST", url: "/admin/accounts/start", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authUrl: string; state: string };
    expect(body.authUrl).toContain("accounts.google.com");
    expect(store.takePendingOAuth(body.state)?.verifier).toBeDefined();
  });

  it("accepts requests forwarded by reverse proxies with chunked transfer-encoding and no content-type", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/start",
      headers: { ...auth, "transfer-encoding": "chunked" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authUrl: string; state: string };
    expect(body.authUrl).toContain("accounts.google.com");
  });
});

describe("POST /admin/accounts/complete", () => {
  it("exchanges the code, discovers the project and stores the account", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (href.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "hudson@gmail.com" }));
      }
      return new Response(
        JSON.stringify({ cloudaicompanionProject: "aicode-consumers", paidTier: { name: "Google AI Pro" } }),
      );
    }) as unknown as typeof fetch;

    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    const start = await app.inject({ method: "POST", url: "/admin/accounts/start", headers: auth });
    const { state } = start.json() as { state: string };

    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/complete",
      headers: auth,
      payload: { callbackUrl: `http://localhost:51121/oauth-callback?code=xyz&state=${state}` },
    });
    expect(response.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    const body = list.json() as { accounts: Array<{ projectId: string; email: string | null }> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.projectId).toBe("aicode-consumers");
    // The email is captured at login and returned masked, never in clear text.
    expect(body.accounts[0]?.email).toBe("h***n@gmail.com");
  });

  it("seeds the model registry so /v1/models is not empty right after login", async () => {
    // Without this, GET /v1/models stays empty until the first refresh tick
    // (QUOTA_REFRESH_TTL_MS, five minutes by default), which reads as a broken deployment.
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (href.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "hudson@gmail.com" }));
      }
      if (href.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-3.8-flash-low": {
                displayName: "Gemini 3.8 Flash (Low)",
                maxTokens: 1_048_576,
                maxOutputTokens: 65_536,
                supportsThinking: true,
                thinkingBudget: 1000,
              },
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({ cloudaicompanionProject: "aicode-consumers", paidTier: { name: "Google AI Pro" } }),
      );
    }) as unknown as typeof fetch;

    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    const start = await app.inject({ method: "POST", url: "/admin/accounts/start", headers: auth });
    const { state } = start.json() as { state: string };

    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/complete",
      headers: auth,
      payload: { callbackUrl: `http://localhost:51121/oauth-callback?code=xyz&state=${state}` },
    });
    expect(response.statusCode).toBe(200);

    const models = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const body = models.json() as { data: Array<{ id: string }> };
    // The public id is the runtime id without its effort suffix.
    expect(body.data.map((model) => model.id)).toContain("gemini-3.8-flash");
  });

  it("rejects an unknown state", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/complete",
      headers: auth,
      payload: { callbackUrl: "http://localhost:51121/oauth-callback?code=x&state=made-up" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a callbackUrl without code", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/complete",
      headers: auth,
      payload: { callbackUrl: "http://localhost:51121/oauth-callback?state=x" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("management", () => {
  beforeEach(() => {
    store.upsertAccount({
      id: "a1",
      email: "hudson@gmail.com",
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "p",
    });
    app = buildServer("test-key", { store, env: ENV, logger: false });
  });

  it("lists with masked email and no token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    const body = response.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts[0]?.email).toBe("h***n@gmail.com");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("accessToken");
  });

  it("does not leak tokens in the detail or the quota", async () => {
    const detail = await app.inject({ method: "GET", url: "/admin/accounts/a1", headers: auth });
    const quota = await app.inject({ method: "GET", url: "/admin/accounts/quota", headers: auth });
    for (const response of [detail, quota]) {
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain("refreshToken");
      expect(serialized).not.toContain("accessToken");
    }
  });

  it("disables and prioritizes via PATCH", async () => {
    await app.inject({
      method: "PATCH",
      url: "/admin/accounts/a1",
      headers: auth,
      payload: { enabled: false, priority: 5 },
    });
    expect(store.getAccount("a1")?.enabled).toBe(false);
    expect(store.getAccount("a1")?.priority).toBe(5);
  });

  it("removes the account and returns 404 afterwards", async () => {
    expect((await app.inject({ method: "DELETE", url: "/admin/accounts/a1", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/accounts/a1", headers: auth })).statusCode).toBe(404);
  });

  it("returns quota groups with percent, ISO reset and time remaining", async () => {
    store.replaceQuota("a1", [
      {
        bucketId: "gemini-weekly",
        window: "weekly",
        displayName: "Weekly Limit Remaining",
        groupName: "Gemini Models",
        groupDescription: "Models within this group: Gemini Flash, Gemini Pro",
        bucketDescription: "You will refresh in 5 days.",
        remainingFraction: 0.99093425,
        resetAt: Date.parse("2026-10-19T20:43:54Z"),
        fetchedAt: Date.parse("2026-10-14T00:00:00Z"),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts/quota",
      headers: auth,
    });
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{
        groups: Array<{ name: string; fetchedAt: string; buckets: Array<Record<string, unknown>> }>;
      }>;
    };

    expect(response.statusCode).toBe(200);
    // Every date on the surface is ISO 8601 UTC (spec §10).
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.accounts[0]?.groups[0]?.name).toBe("Gemini Models");
    expect(body.accounts[0]?.groups[0]?.fetchedAt).toBe("2026-10-14T00:00:00Z");

    const bucket = body.accounts[0]?.groups[0]?.buckets[0] ?? {};
    expect(bucket.remainingPercent).toBe(99);
    expect(bucket.remainingFraction).toBe(0.99093425);
    expect(bucket.resetAt).toBe("2026-10-19T20:43:54Z");
    expect(typeof bucket.resetsIn).toBe("string");
  });

  it("reports no groups and the reason when the summary could not be read", async () => {
    store.setQuotaSummaryError("a1", "the summary needs a paid subscription");

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts/quota",
      headers: auth,
    });
    const body = response.json() as {
      accounts: Array<{ groups: unknown[]; quotaSummaryError: string }>;
    };

    expect(body.accounts[0]?.groups).toEqual([]);
    expect(body.accounts[0]?.quotaSummaryError).toBe("the summary needs a paid subscription");
  });

  it("renders the admin dates as ISO and the cooldown as a phrase", async () => {
    // A far-future instant on purpose: `expireCooldowns` nulls a cooldown once it passes,
    // so a near date would make this assertion fail on its own as the clock advances.
    store.setStatus("a1", "cooldown", { cooldownUntil: Date.parse("2099-01-01T00:00:00Z") });

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts",
      headers: auth,
    });
    const account = (response.json() as { accounts: Array<Record<string, unknown>> }).accounts[0] ?? {};

    expect(account.cooldownUntil).toBe("2099-01-01T00:00:00Z");
    expect(typeof account.cooldownResetsIn).toBe("string");
    expect(account.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(account.lastUsedAt).toBeNull();
  });

  it("returns the groups on a single account", async () => {
    store.replaceQuota("a1", [
      {
        bucketId: "3p-5h",
        window: "5h",
        displayName: "Five Hour Limit Remaining",
        groupName: "Claude and GPT models",
        groupDescription: null,
        bucketDescription: null,
        remainingFraction: 0.5,
        resetAt: null,
        fetchedAt: Date.now(),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts/a1",
      headers: auth,
    });
    const body = response.json() as { groups: Array<{ name: string }> };

    // The old per-model rows no longer exist in the store, so this endpoint must
    // return the group view or it would always report an empty quota.
    expect(body.groups[0]?.name).toBe("Claude and GPT models");
    expect(JSON.stringify(body)).not.toContain("refresh_token");
  });

  it("exposes the tier as an object on every account view", async () => {
    store.setPaidTier("a1", { id: "g1-pro-tier", name: "Google AI Pro" });

    for (const url of ["/admin/accounts", "/admin/accounts/quota", "/admin/accounts/a1"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: auth,
      });
      const raw = response.body;

      // One projection feeds all six admin endpoints, so the shape cannot drift
      // between them (spec D15, §9.1).
      expect(raw).toContain('"id":"g1-pro-tier"');
      expect(raw).toContain('"name":"Google AI Pro"');
    }
  });

  it("reports an unknown tier as null rather than as a tier", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts",
      headers: auth,
    });
    const account = (response.json() as { accounts: Array<Record<string, unknown>> }).accounts[0] ?? {};

    expect(account.paidTier).toBeNull();
  });

  it("shows the free tier beside the reason there are no groups", async () => {
    store.setPaidTier("a1", { id: "free-tier", name: "Antigravity Starter Quota" });
    store.setQuotaSummaryError("a1", "The quota summary requires a paid subscription");

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts/quota",
      headers: auth,
    });
    const account = (response.json() as { accounts: Array<Record<string, unknown>> }).accounts[0] ?? {};

    // The operator's question is "why no groups?", and the tier answers it (spec §9.1).
    expect(account.paidTier).toEqual({ id: "free-tier", name: "Antigravity Starter Quota" });
    expect(account.groups).toEqual([]);
    expect(String(account.quotaSummaryError)).toContain("paid subscription");
  });

  it("returns the account with the tier and no duplicate top-level paidTier", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
        );
      }
      if (url.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            cloudaicompanionProject: "aicode-consumers",
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
          }),
        );
      }
      return new Response(JSON.stringify({ email: "x@y.com" }));
    }) as unknown as typeof fetch;

    await app.close();
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const started = await app.inject({
      method: "POST",
      url: "/admin/accounts/start",
      headers: auth,
    });
    const { state } = started.json() as { state: string };

    const response = await app.inject({
      method: "POST",
      url: "/admin/accounts/complete",
      headers: auth,
      payload: { callbackUrl: `http://localhost:1455/?code=abc&state=${state}` },
    });
    const body = response.json() as { account: Record<string, unknown>; paidTier?: unknown };

    expect(response.statusCode).toBe(200);
    // One fact, one shape: the account object carries the tier, and the top-level
    // duplicate that used to return the bare name is gone (spec §9.1).
    expect(body.account.paidTier).toEqual({ id: "g1-pro-tier", name: "Google AI Pro" });
    expect(body.paidTier).toBeUndefined();
    expect(body.account.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("returns 404 when removing a non-existent account", async () => {
    expect((await app.inject({ method: "DELETE", url: "/admin/accounts/nada", headers: auth })).statusCode).toBe(404);
  });

  it("returns lean pool quota summary on /accounts/quota", async () => {
    store.replaceQuota("a1", [
      {
        bucketId: "gemini-5h",
        window: "5h",
        displayName: "Five Hour Limit Remaining",
        groupName: "Gemini Models",
        groupDescription: null,
        bucketDescription: null,
        remainingFraction: 0.95,
        resetAt: Date.now() + 3600_000,
        fetchedAt: Date.now(),
      },
      {
        bucketId: "3p-5h",
        window: "5h",
        displayName: "Five Hour Limit Remaining",
        groupName: "Claude and GPT models",
        groupDescription: null,
        bucketDescription: null,
        remainingFraction: 0.6,
        resetAt: Date.now() + 1800_000,
        fetchedAt: Date.now(),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/accounts/quota",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, any>;
    expect(body.activeAccounts).toBe(1);
    expect(body.gemini).toEqual({
      available: true,
      "5h": { remainingPercent: 95, resetsIn: expect.any(String) },
      weekly: { remainingPercent: null, resetsIn: null },
    });
    expect(body.claudeGpt).toEqual({
      available: true,
      "5h": { remainingPercent: 60, resetsIn: expect.any(String) },
      weekly: { remainingPercent: null, resetsIn: null },
    });
    // In default lean mode, accounts list is omitted
    expect(body.accounts).toBeUndefined();
  });

  it("returns detailed pool quota on /accounts/quota?detailed=true", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/accounts/quota?detailed=true",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, any>;
    expect(body.activeAccounts).toBe(1);
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  it("includes lean pool summary on /admin/accounts/quota alongside accounts list", async () => {
    store.replaceQuota("a1", [
      {
        bucketId: "gemini-5h", window: "5h", displayName: null, groupName: "Gemini Models",
        groupDescription: null, bucketDescription: null, remainingFraction: 0.95,
        resetAt: Date.now() + 3600_000, fetchedAt: Date.now(),
      },
      {
        bucketId: "gemini-weekly", window: "weekly", displayName: null, groupName: "Gemini Models",
        groupDescription: null, bucketDescription: null, remainingFraction: 0.8,
        resetAt: Date.now() + 86400_000, fetchedAt: Date.now(),
      },
      {
        bucketId: "3p-5h", window: "5h", displayName: null, groupName: "Claude and GPT models",
        groupDescription: null, bucketDescription: null, remainingFraction: 0.6,
        resetAt: Date.now() + 1800_000, fetchedAt: Date.now(),
      },
      {
        bucketId: "3p-weekly", window: "weekly", displayName: null, groupName: "Claude and GPT models",
        groupDescription: null, bucketDescription: null, remainingFraction: 0.4,
        resetAt: Date.now() + 43200_000, fetchedAt: Date.now(),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/admin/accounts/quota",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, any>;
    expect(body.activeAccounts).toBe(1);
    expect(body.gemini.available).toBe(true);
    expect(body.gemini["5h"].remainingPercent).toBe(95);
    expect(body.gemini.weekly.remainingPercent).toBe(80);
    expect(body.claudeGpt.available).toBe(true);
    expect(body.claudeGpt["5h"].remainingPercent).toBe(60);
    expect(body.claudeGpt.weekly.remainingPercent).toBe(40);
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  it("requires bearer auth on /accounts/quota", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/accounts/quota",
    });
    expect(response.statusCode).toBe(401);
  });
});
