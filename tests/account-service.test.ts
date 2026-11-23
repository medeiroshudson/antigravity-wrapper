import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../src/lib/accounts/service.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { TurnRunner } from "../src/lib/chat/turn.js";
import { UpstreamError } from "../src/lib/antigravity/errors.js";
import { getPublicModels, resetRegistryForTests } from "../src/config/models.js";
import { captureLogger } from "./fixtures/logger.js";

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
  resetRegistryForTests();
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

  it("classes a revoked grant as an auth failure", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    await expect(service.ensureFresh(store.getAccount("a1")!)).rejects.toMatchObject({ kind: "auth" });
  });

  it("classes a 401 from the token endpoint as an auth failure", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"unauthorized_client"}', { status: 401 }),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    await expect(service.ensureFresh(store.getAccount("a1")!)).rejects.toMatchObject({ kind: "auth" });
  });

  it("classes a 200 without an access token as a dead credential, not an outage", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ expires_in: 3600 })),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    // Nothing to retry: a body with no token cannot recover, so it must park the account
    // instead of spending a token call on every request forever.
    await expect(service.ensureFresh(store.getAccount("a1")!)).rejects.toMatchObject({ kind: "auth" });
  });

  it("classes a token-endpoint outage as a server error, not a dead credential", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const fetchImpl = vi.fn(
      async () => new Response("upstream down", { status: 503 }),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });
    // A Google blip must not read as "this account's token is dead": `server_error` still
    // fails the request over to the next account, but `applyFailure` leaves its state alone.
    await expect(service.ensureFresh(store.getAccount("a1")!)).rejects.toMatchObject({
      kind: "server_error",
    });
    expect(store.getAccount("a1")?.status).toBe("active");
  });
});

describe("onboard", () => {
  function pendingAccount(id = "a1") {
    return store.upsertAccount({
      id,
      email: `${id}@x.com`,
      refreshToken: `r-${id}`,
      accessToken: `a-${id}`,
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: null,
    });
  }

  it("onboard marks the account active and seeds the catalog when a project is assigned", async () => {
    pendingAccount("a1");
    store.setStatus("a1", "invalid", { statusKind: "validation_required", lastError: "pending" });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("fetchAvailableModels")) {
        return new Response(JSON.stringify({ models: { "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" } } }));
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers", paidTier: { id: "free-tier", name: "Free" } }));
    }) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });

    const outcome = await service.onboard("a1");

    expect(outcome).toMatchObject({ status: "active", projectId: "aicode-consumers" });
    expect(store.getAccount("a1")).toMatchObject({ projectId: "aicode-consumers", status: "active", statusKind: null });
    // The catalog is fed from the same run, so the account's models are public immediately.
    expect(getPublicModels().map((model) => model.id)).toContain("gemini-3.8-flash");
  });

  it("onboard records validation_required and keeps the account out of the pool", async () => {
    pendingAccount("a1");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ineligibleTiers: [{ reasonCode: "VALIDATION_REQUIRED", validationUrl: "https://accounts.google.com/x" }] })),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });

    const outcome = await service.onboard("a1");

    expect(outcome).toMatchObject({ status: "validation_required" });
    expect(store.getAccount("a1")).toMatchObject({ status: "invalid", statusKind: "validation_required", projectId: null });
    expect(store.getAccount("a1")?.lastError).toContain("https://accounts.google.com/x");
  });

  it("onboard records onboarding_pending when provisioning fails", async () => {
    pendingAccount("a1");
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });

    await service.onboard("a1");

    expect(store.getAccount("a1")).toMatchObject({ status: "invalid", statusKind: "onboarding_pending" });
  });

  it("onboard returns null for an unknown account", async () => {
    const service = new AccountService({ store, env: ENV });
    expect(await service.onboard("nope")).toBeNull();
  });

  it("onboard re-enables an account an operator had parked", async () => {
    pendingAccount("a1");
    store.setEnabled("a1", false);
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("fetchAvailableModels")
        ? new Response(JSON.stringify({ models: {} }))
        : new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" })),
    ) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });

    await service.onboard("a1");

    // Provisioned by Google means usable: a parked account would otherwise stay out
    // of the pool with no reason left to show.
    expect(store.getAccount("a1")?.enabled).toBe(true);
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

  it("records the cause alongside the state, so a parked account is explainable", () => {
    seed("a1");
    seed("a2");
    seed("a3");
    const service = new AccountService({ store, env: ENV });
    service.applyFailure("a1", new UpstreamError("quota", 429, "quota", 7_200_000));
    expect(store.getAccount("a1")?.statusKind).toBe("quota");

    service.applyFailure("a2", new UpstreamError("transient_rate_limit", 429, "slow down"));
    expect(store.getAccount("a2")?.statusKind).toBe("rate_limited");

    service.applyFailure("a3", new UpstreamError("auth", 401, "expired"));
    expect(store.getAccount("a3")?.statusKind).toBe("auth");
  });

  it("places account in cooldown on transient_rate_limit", () => {
    seed("a1");
    const service = new AccountService({ store, env: { ...ENV, COOLDOWN_TRANSIENT_MS: "45000" } });
    const before = Date.now();
    service.applyFailure("a1", new UpstreamError("transient_rate_limit", 429, "Too many requests"));
    const acc = store.getAccount("a1");
    expect(acc?.status).toBe("cooldown");
    expect(acc?.cooldownUntil).toBeGreaterThanOrEqual(before + 45000);
    expect(acc?.lastError).toBe("Too many requests");
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

  it("keeps a recorded TOS block when the credential fails too, stacking the note once", () => {
    seed();
    store.setStatus("a1", "invalid", {
      statusKind: "tos_blocked",
      lastError: "blocked for a Terms of Service violation; appeal at https://forms.gle/x",
    });
    const service = new AccountService({ store, env: ENV });
    const error = new UpstreamError("auth", 401, "Token exchange failed (400): invalid_grant");

    service.applyFailure("a1", error);
    service.applyFailure("a1", error);

    const account = store.getAccount("a1");
    // The appeal link is the only local copy of an upstream verdict; a dead token must not
    // erase it, and a retry must not duplicate the note.
    expect(account?.statusKind).toBe("tos_blocked");
    expect(account?.lastError).toContain("appeal at https://forms.gle/x");
    expect(account?.lastError?.match(/invalid_grant/g)?.length).toBe(1);
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

describe("scoped cooldowns", () => {
  const NOW = 2_000_000_000_000;

  function service(over: NodeJS.ProcessEnv = ENV): AccountService {
    return new AccountService({ store, env: over, now: () => NOW });
  }

  it("benches only the family that failed", () => {
    seed("a1");
    service().applyFailure("a1", new UpstreamError("quota", 429, "quota wall", 7_200_000), "gemini-3.8-flash-low");

    expect(store.cooldownsFor("a1", NOW)).toEqual([
      { scope: "gemini-", kind: "quota", until: NOW + 7_200_000, reason: "quota wall", failures: 1 },
    ]);
    expect(store.getAccount("a1")?.statusKind).toBe("quota");
  });

  it("leaves the other family routable", async () => {
    seed("a1");
    service().applyFailure("a1", new UpstreamError("quota", 429, "quota wall", 7_200_000), "gemini-3.8-flash-low");

    // Measured: one drained family used to take a fully-stocked one out of service.
    expect((await service().orderFor("claude-opus-4-6-thinking")).map((a) => a.id)).toEqual(["a1"]);
    expect(await service().orderFor("gemini-3.8-flash-low")).toEqual([]);
  });

  it("benches the whole account when the family is unmeasured", () => {
    seed("a1");
    service().applyFailure("a1", new UpstreamError("quota", 429, "quota wall", 60_000), "llama-4-scout");
    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope)).toEqual(["*"]);
  });

  it("names the wait the backend gave, and the policy default when it gave none", () => {
    seed("a1");
    service({ ...ENV, COOLDOWN_QUOTA_MS: "120000" }).applyFailure(
      "a1",
      new UpstreamError("quota", 429, "quota wall"),
      "gemini-3.8-flash-low",
    );
    expect(store.cooldownsFor("a1", NOW)[0]?.until).toBe(NOW + 120_000);
  });

  it("clears only the family's cooldown when a turn succeeds there", () => {
    seed("a1");
    const svc = service();
    svc.applyFailure("a1", new UpstreamError("quota", 429, "gemini wall", 60_000), "gemini-3.8-flash-low");
    svc.applyFailure("a1", new UpstreamError("quota", 429, "3p wall", 60_000), "claude-opus-4-6-thinking");

    svc.clearCooldown("a1", "gemini-3.8-flash-low");

    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope)).toEqual(["3p-"]);
  });

  it("clears every cooldown when the verdict belongs to the whole account", () => {
    seed("a1");
    const svc = service();
    svc.applyFailure("a1", new UpstreamError("quota", 429, "wall", 60_000), "gemini-3.8-flash-low");
    // A probe or an onboarding failure benches the account, not a family.
    svc.applyFailure("a1", new UpstreamError("quota", 429, "wall", 60_000));
    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope).sort()).toEqual(["*", "gemini-"]);

    svc.clearCooldown("a1");
    expect(store.cooldownsFor("a1", NOW)).toEqual([]);
  });

  it("releases only the account-wide bench when the model family is unmeasured", () => {
    seed("a1");
    const svc = service();
    svc.applyFailure("a1", new UpstreamError("quota", 429, "wall", 60_000), "gemini-3.8-flash-low");
    svc.applyFailure("a1", new UpstreamError("quota", 429, "wall", 60_000));

    // An unmeasured model proves nothing about `gemini-`; it only proves the account-wide
    // wait is over.
    svc.clearCooldown("a1", "llama-4-scout");

    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope)).toEqual(["gemini-"]);
  });

  it("relaxes a lone account benched by a throttle and logs it", async () => {
    seed("a1");
    const { logger, lines } = captureLogger();
    const svc = new AccountService({ store, env: ENV, now: () => NOW, logger });
    svc.applyFailure("a1", new UpstreamError("transient_rate_limit", 429, "slow down", 30_000), "gemini-3.8-flash-low");

    expect((await svc.orderFor("gemini-3.8-flash-low")).map((a) => a.id)).toEqual(["a1"]);
    const line = lines.find((l) => l.msg === "cooldowns relaxed");
    expect(line?.level).toBe("debug");
    expect(line?.obj).toMatchObject({ runtimeModel: "gemini-3.8-flash-low", relaxed: 1 });
  });

  it("reports the pool as cooling from the table", () => {
    seed("a1");
    seed("a2");
    const svc = service();
    svc.applyFailure("a1", new UpstreamError("transient_rate_limit", 429, "slow down", 60_000), "gemini-3.8-flash-low");

    expect(svc.poolSummary()).toEqual({
      enabled: 2,
      cooling: 1,
      soonestCooldownUntil: NOW + 60_000,
    });
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
      "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 1000 },
      "claude-opus-4-6-thinking": { displayName: "Claude Opus 4.6 (Thinking)", maxTokens: 250_000, maxOutputTokens: 64_000, supportsThinking: true, thinkingBudget: 1024 },
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

  it("stores the free tier without spending the summary call", async () => {
    seed();
    const fetchImpl = upstream({
      summary: {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "You do not have a valid license of this product. (#3501)",
          details: [{ reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" }],
        },
      },
      summaryStatus: 403,
      codeAssist: {
        cloudaicompanionProject: "p",
        paidTier: { id: "free-tier", name: "Antigravity Starter Quota" },
      },
    });
    await new AccountService({ store, env: ENV, fetchImpl }).refreshQuota("a1");

    const account = store.getAccount("a1");
    // The tier is what lets the refresh skip the summary RPC: a known free-tier account
    // gets a 403 from it, so the call is never made and there is no error to report.
    expect(account?.paidTierId).toBe("free-tier");
    expect(account?.quotaSummaryError).toBeNull();
    expect(store.getQuota("a1")).toEqual([]);
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(urls.some((url) => url.includes("retrieveUserQuotaSummary"))).toBe(false);
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
    // The catalog keeps coming from fetchAvailableModels: it is the only source of model
    // ids (spec §6). The public id is the runtime id without its effort suffix.
    expect(ids).toContain("claude-opus-4-6");
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

  it("falls back to the catalog's quotaInfo when the summary is denied", async () => {
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
        catalog: {
          models: {
            "gemini-3.8-flash-low": {
              quotaInfo: { remainingFraction: 0.35, resetTime: "2026-10-19T20:39:33Z" },
            },
            "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.7 } },
          },
        },
        summary: subscription403,
        summaryStatus: 403,
      }),
    }).refreshQuota("a1");

    const quota = store.getQuota("a1");
    expect(quota.map((row) => row.bucketId)).toEqual(["gemini-models", "3p-models"]);
    expect(quota[0]?.remainingFraction).toBe(0.35);
    expect(quota[0]?.resetAt).toBe(Date.parse("2026-10-19T20:39:33Z"));
    expect(quota[1]?.remainingFraction).toBe(0.7);
    // Quota was observed, just not through the summary: there is no error to report.
    expect(store.getAccount("a1")?.quotaSummaryError).toBeNull();
    expect(store.getAccount("a1")?.status).toBe("active");
  });

  it("keeps the paid summary over the catalog's quotaInfo", async () => {
    seed();
    await new AccountService({
      store,
      env: ENV,
      fetchImpl: upstream({
        catalog: {
          models: {
            "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.01 } },
          },
        },
      }),
    }).refreshQuota("a1");

    expect(store.getQuota("a1").map((row) => row.bucketId)).toEqual([
      "gemini-weekly",
      "gemini-5h",
    ]);
    expect(store.getAccount("a1")?.quotaSummaryError).toBeNull();
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

  it("summarizes a successful refresh and never logs a token", async () => {
    seed();
    const { logger, lines } = captureLogger();
    await new AccountService({ store, env: ENV, fetchImpl: upstream(), logger }).refreshQuota("a1");

    const line = lines.find((l) => l.msg === "quota refreshed");
    expect(line?.level).toBe("info");
    expect(line?.obj.accountId).toBe("a1");
    expect(line?.obj.models).toBeGreaterThan(0);
    expect(line?.obj.quotaRows).toBe(2);
    expect(line?.obj.paidTierId).toBe("g1-pro-tier");
    // No line may carry the access token the refresh works with.
    expect(lines.some((l) => JSON.stringify(l.obj).includes("a-a1"))).toBe(false);
  });

  it("logs a token refresh failure before failing the account over", async () => {
    seed("a1", { accessExpiresAt: Date.now() - 1000 });
    const { logger, lines } = captureLogger();
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    ) as unknown as typeof fetch;
    await new AccountService({ store, env: ENV, fetchImpl, logger })
      .ensureFresh(store.getAccount("a1")!)
      .catch(() => undefined);

    const line = lines.find((l) => l.msg === "token refresh failed");
    expect(line?.level).toBe("warn");
    expect(line?.obj.accountId).toBe("a1");
  });

  it("refreshQuota does nothing for an account without a projectId", async () => {
    store.upsertAccount({ id: "a1", email: "a1@x.com", refreshToken: "r", accessToken: "t", accessExpiresAt: Date.now() + 3_600_000, projectId: null });
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const service = new AccountService({ store, env: ENV, fetchImpl });

    await service.refreshQuota("a1");

    expect(fetchImpl).not.toHaveBeenCalled();
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
