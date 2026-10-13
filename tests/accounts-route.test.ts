import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";

const auth = { authorization: "Bearer test-key" };
const ENV = { ANTIGRAVITY_CLIENT_ID: "cid", ANTIGRAVITY_CLIENT_SECRET: "sec" };
let app: FastifyInstance;
let store: AccountStore;

beforeEach(() => {
  store = new AccountStore(":memory:");
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

  it("returns the aggregated quota summary", async () => {
    store.saveQuota([
      {
        accountId: "a1",
        modelId: "gemini-3-pro",
        window: "week",
        remainingFraction: 0.5,
        resetAt: 1_700_000_000_000,
        fetchedAt: 1_700_000_100_000,
      },
    ]);
    const response = await app.inject({ method: "GET", url: "/admin/accounts/quota", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accounts: Array<{ id: string; quota: Array<Record<string, unknown>> }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.id).toBe("a1");
    expect(body.accounts[0]?.quota).toHaveLength(1);
    expect(body.accounts[0]?.quota[0]).toMatchObject({
      modelId: "gemini-3-pro",
      window: "week",
      remainingFraction: 0.5,
      resetAt: 1_700_000_000_000,
      fetchedAt: 1_700_000_100_000,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("accessToken");
  });

  it("returns 404 when removing a non-existent account", async () => {
    expect((await app.inject({ method: "DELETE", url: "/admin/accounts/nada", headers: auth })).statusCode).toBe(404);
  });
});
