import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { resetRegistryForTests } from "../src/config/models.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { TOS_VIOLATION_BODY } from "./fixtures/tos.js";

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

describe("GET /admin/accounts", () => {
  it("reports the effective state and its cause, not just 'active'", async () => {
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "t",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });
    app = buildServer("test-key", { store, env: ENV, logger: false });

    await app.inject({
      method: "PATCH",
      url: "/admin/accounts/a1",
      headers: auth,
      payload: { enabled: false },
    });

    const list = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    expect(list.json().accounts[0]).toMatchObject({
      status: "active",
      enabled: false,
      state: "disabled",
      usable: false,
      statusKind: "operator_disabled",
    });
  });
});

describe("POST /admin/accounts/:id/recheck", () => {
  function seed() {
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "tok",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });
  }

  it("clears a recorded block and re-enables the account when the upstream serves the probe", async () => {
    seed();
    store.setStatus("a1", "invalid", { statusKind: "tos_blocked", lastError: "blocked" });
    store.setEnabled("a1", false);
    const fetchImpl = vi.fn(
      async () =>
        new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/recheck", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().probe).toMatchObject({ ok: true, status: 200 });
    expect(res.json().account).toMatchObject({
      status: "active",
      state: "active",
      usable: true,
      enabled: true,
      statusKind: null,
      lastError: null,
    });
  });

  it("leaves the account parked when the upstream still refuses it", async () => {
    seed();
    store.setStatus("a1", "invalid", { statusKind: "tos_blocked", lastError: "blocked" });
    store.setEnabled("a1", false);
    const fetchImpl = vi.fn(
      async () => new Response(TOS_VIOLATION_BODY, { status: 403 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/recheck", headers: auth });

    expect(res.json().account).toMatchObject({ state: "invalid", enabled: false });
  });

  it("keeps the block, with the appeal, when the upstream repeats TOS_VIOLATION", async () => {
    seed();
    const fetchImpl = vi.fn(
      async () => new Response(TOS_VIOLATION_BODY, { status: 403 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/recheck", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().probe).toMatchObject({ ok: false, status: 403, kind: "account_blocked" });
    expect(res.json().account).toMatchObject({ status: "invalid", state: "invalid", statusKind: "tos_blocked" });
    expect(res.json().account.lastError).toContain("forms.gle");
  });

  it("returns 404 for an account that does not exist", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const res = await app.inject({ method: "POST", url: "/admin/accounts/nope/recheck", headers: auth });
    expect(res.statusCode).toBe(404);
  });
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
    // The email is captured at login and returned in clear text to identify the account.
    expect(body.accounts[0]?.email).toBe("hudson@gmail.com");
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

  it("auto-onboards account through /admin/accounts/complete when project is initially unassigned", async () => {
    let onboardInvoked = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (href.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "hmedeiros.ai.004@gmail.com" }));
      }
      if (href.includes("onboardUser")) {
        onboardInvoked = true;
        return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }));
      }
      if (href.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }),
        );
      }
      if (href.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: {} }));
      }
      return new Response(JSON.stringify({}));
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
    expect(onboardInvoked).toBe(true);
    const body = response.json() as { account: { email: string; projectId: string } };
    expect(body.account.email).toBe("hmedeiros.ai.004@gmail.com");
    expect(body.account.projectId).toBe("aicode-consumers");
  });

  it("answers 202 with the onboarding link and persists the pending account on VALIDATION_REQUIRED", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (href.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "hmedeiros.ai.004@gmail.com" }));
      }
      if (href.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            ineligibleTiers: [
              {
                tierId: "free-tier",
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "Terms acceptance required",
                validationUrl: "https://accounts.google.com/signin/continue?flowName=GlifWebSignIn",
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({}));
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

    // Login is not a dead end any more: the account is registered, the state records why
    // it cannot serve, and the reply hands back the link that finishes the job (spec D6).
    expect(response.statusCode).toBe(202);
    const body = response.json() as {
      account: { id: string; status: string; statusKind: string; email: string };
      onboarding: { status: string; validationUrl: string; reason: string | null };
    };
    expect(body.onboarding.status).toBe("validation_required");
    expect(body.onboarding.validationUrl).toContain("authuser=hmedeiros.ai.004%40gmail.com");
    expect(body.onboarding.validationUrl).toContain("login_hint=hmedeiros.ai.004%40gmail.com");
    expect(body.onboarding.reason).toBe("Terms acceptance required");
    expect(body.account.statusKind).toBe("validation_required");
    expect(response.headers.location).toBe(`/admin/accounts/${body.account.id}/onboard`);

    const list = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    expect(list.json().accounts).toHaveLength(1);
  });

  // The provisioning poll waits 3 x 1.5 s before it gives up (onboardAccount's default),
  // so this case needs more than vitest's 5 s default.
  it("persists a pending account with 400 when provisioning finds no project", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (href.includes("userinfo")) {
        return new Response(JSON.stringify({ email: "hmedeiros.ai.004@gmail.com" }));
      }
      if (href.includes("onboardUser")) {
        return new Response(JSON.stringify({}), { status: 500 });
      }
      if (href.includes("loadCodeAssist")) {
        return new Response(JSON.stringify({ allowedTiers: [{ id: "free-tier", isDefault: true }] }));
      }
      return new Response(JSON.stringify({}));
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

    // The account is kept even though provisioning failed: `onboard` is what retries it,
    // so throwing the login away would force the operator to redo the OAuth consent.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("loadCodeAssist returned no projectId");
    const list = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    expect(list.json().accounts).toHaveLength(1);
    expect(list.json().accounts[0]).toMatchObject({
      projectId: null,
      status: "invalid",
      statusKind: "onboarding_pending",
      usable: false,
    });
  }, 20_000);

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

describe("POST /admin/accounts/:id/onboard", () => {
  function seedPending(id = "a1") {
    store.upsertAccount({
      id,
      email: `${id}@x.com`,
      refreshToken: "r",
      accessToken: "t",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: null,
    });
  }

  /** loadCodeAssist answers a provisioned project; fetchAvailableModels answers one model. */
  function provisionedFetch() {
    return vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
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
        JSON.stringify({ cloudaicompanionProject: "aicode-consumers", paidTier: { id: "free-tier", name: "Antigravity Starter Quota" } }),
      );
    }) as unknown as typeof fetch;
  }

  it("resumes onboarding for a registered account and seeds the catalog", async () => {
    seedPending();
    store.setStatus("a1", "invalid", { statusKind: "validation_required", lastError: "pending" });
    app = buildServer("test-key", { store, env: ENV, fetchImpl: provisionedFetch(), logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      account: { id: "a1", projectId: "aicode-consumers", status: "active", statusKind: null, usable: true },
      onboarding: { status: "active", projectId: "aicode-consumers" },
    });
    // Task 3 seeds the registry inside `onboard`; the route must not do it a second time.
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    expect((models.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain("gemini-3.8-flash");
  });

  it("answers 200 with the same link while Google still demands validation", async () => {
    seedPending();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ineligibleTiers: [
              {
                tierId: "free-tier",
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "Terms acceptance required",
                validationUrl: "https://accounts.google.com/signin/continue?flowName=GlifWebSignIn",
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().onboarding).toMatchObject({ status: "validation_required" });
    expect(res.json().account.statusKind).toBe("validation_required");
  });

  it("answers 502 when the refresh token is dead", async () => {
    // `onboard` deliberately lets `ensureFresh`'s `UpstreamError("auth")` escape: the
    // request is fine, the account's credential is not, and only a re-login fixes it.
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "dead",
      accessToken: "expired",
      accessExpiresAt: 0,
      projectId: null,
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }));
    }) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain("Token exchange failed (400)");
    // Nothing was written: the failure happened before the outcome could be recorded.
    expect(store.getAccount("a1")?.statusKind).toBeNull();
  });

  it("answers 404 for an unknown account on onboard", async () => {
    app = buildServer("test-key", { store, env: ENV, logger: false });
    const res = await app.inject({ method: "POST", url: "/admin/accounts/nope/onboard", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("answers 502 when no endpoint can be reached during onboarding", async () => {
    seedPending();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth });

    // The wrapper could not reach Google: that is a bad gateway, not a bad request.
    expect(res.statusCode).toBe(502);
    expect(res.json().onboarding).toMatchObject({ status: "failed", code: "no_endpoint" });
    expect(res.json().error.message).toContain("Could not discover the projectId");
    expect(res.json().account).toMatchObject({ id: "a1", projectId: null, statusKind: "onboarding_pending" });
    expect(store.getAccount("a1")?.statusKind).toBe("onboarding_pending");
  });

  it("clears a recorded TOS block when onboarding finally assigns a project", async () => {
    seedPending();
    store.setStatus("a1", "invalid", { statusKind: "tos_blocked", lastError: "blocked" });
    store.setEnabled("a1", false);
    app = buildServer("test-key", { store, env: ENV, fetchImpl: provisionedFetch(), logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth });

    // Provisioning the project is the way back from a block: the recorded kind and the
    // operator's park both have to go, or the account stays out of the pool for ever.
    expect(res.json().account).toMatchObject({ status: "active", statusKind: null, enabled: true, usable: true });
    expect(store.getAccount("a1")?.lastError).toBeNull();
  });

  it("answers 200 on every concurrent resume without duplicating the account", async () => {
    seedPending();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: provisionedFetch(), logger: false });

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth }),
      app.inject({ method: "POST", url: "/admin/accounts/a1/onboard", headers: auth }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const list = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    expect(list.json().accounts).toHaveLength(1);
  });
});

describe("POST /admin/accounts/:id/refresh", () => {
  it("rejects a quota refresh for an account that was never onboarded", async () => {
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "t",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: null,
    });
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const res = await app.inject({ method: "POST", url: "/admin/accounts/a1/refresh", headers: auth });

    // 400, not 409: `toOpenAIErrorBody` only names a caller-facing `type` for 400/422/404/429,
    // and this is a request the caller can fix by calling the onboarding route.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("/admin/accounts/a1/onboard");
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("lists with clear-text email and no token", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/accounts", headers: auth });
    const body = response.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts[0]?.email).toBe("hudson@gmail.com");
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

  it("exposes pacing fields on the detailed bucket view", async () => {
    store.replaceQuota("a1", [{
      bucketId: "gemini-5h", window: "5h", displayName: null, groupName: "Gemini Models",
      groupDescription: null, bucketDescription: null, remainingFraction: 0.8,
      resetAt: Date.now() + 2.5 * 3_600_000, fetchedAt: Date.now(),
    }]);
    const response = await app.inject({ method: "GET", url: "/admin/accounts/a1", headers: auth });
    // The route runs on the real clock, so the exact age cannot be asserted here: what
    // matters is that both fields are present, numeric, and in range on the wire.
    const body = response.json() as {
      groups: Array<{ buckets: Array<Record<string, unknown>> }>;
    };
    const bucket = body.groups[0]?.buckets[0] ?? {};

    expect(response.statusCode).toBe(200);
    expect(typeof bucket.windowElapsedPercent).toBe("number");
    expect(bucket.windowElapsedPercent).toBeGreaterThanOrEqual(0);
    expect(bucket.windowElapsedPercent).toBeLessThanOrEqual(100);
    expect(typeof bucket.pacingDeficit).toBe("number");
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
      availableAccounts: 1,
      observedAt: expect.any(String),
      "5h": {
        remainingPercent: 95,
        worstRemainingPercent: 95,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
    });
    expect(body.claudeGpt).toEqual({
      available: true,
      availableAccounts: 1,
      observedAt: expect.any(String),
      "5h": {
        remainingPercent: 60,
        worstRemainingPercent: 60,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
      weekly: {
        remainingPercent: null,
        worstRemainingPercent: null,
        measuredAccounts: 0,
        nextResetAt: null,
        resetsIn: null,
      },
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
    expect(body.accounts[0]?.email).toBe("hudson@gmail.com");
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
    expect(body.gemini).toEqual({
      available: true,
      availableAccounts: 1,
      observedAt: expect.any(String),
      "5h": {
        remainingPercent: 95,
        worstRemainingPercent: 95,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
      weekly: {
        remainingPercent: 80,
        worstRemainingPercent: 80,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
    });
    expect(body.claudeGpt).toEqual({
      available: true,
      availableAccounts: 1,
      observedAt: expect.any(String),
      "5h": {
        remainingPercent: 60,
        worstRemainingPercent: 60,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
      weekly: {
        remainingPercent: 40,
        worstRemainingPercent: 40,
        measuredAccounts: 1,
        nextResetAt: expect.any(String),
        resetsIn: expect.any(String),
      },
    });
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts[0]?.email).toBe("hudson@gmail.com");
  });

  it("requires bearer auth on /accounts/quota", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/accounts/quota",
    });
    expect(response.statusCode).toBe(401);
  });
});
