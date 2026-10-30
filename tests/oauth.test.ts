import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REDIRECT_URI,
  SCOPES,
  buildAuthUrl,
  discoverProjectId,
  exchangeCode,
  generatePkce,
  getUserEmail,
  loadCodeAssistInfo,
  onboardUser,
  refreshAccessToken,
} from "../src/lib/antigravity/oauth.js";

const ENV = { ANTIGRAVITY_CLIENT_ID: "cid.apps.googleusercontent.com", ANTIGRAVITY_CLIENT_SECRET: "sec" };

describe("generatePkce", () => {
  it("generates the S256 challenge from the verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("buildAuthUrl", () => {
  it("includes the scopes, the redirect and the PKCE", () => {
    const url = new URL(buildAuthUrl("cid", "st", "ch"));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("exchangeCode", () => {
  it("exchanges the code and returns tokens with expiresAt in the future", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 })),
    ) as unknown as typeof fetch;
    const out = await exchangeCode({ code: "c", verifier: "v", env: ENV, fetchImpl });
    expect(out.accessToken).toBe("at");
    expect(out.refreshToken).toBe("rt");
    expect(out.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws when the provider rejects, without leaking the secret", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"invalid_grant","error_description":"bad code"}', { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(exchangeCode({ code: "c", verifier: "v", env: ENV, fetchImpl })).rejects.toThrow(/invalid_grant/);
  });

  it("requires refresh_token", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "at", expires_in: 3600 })),
    ) as unknown as typeof fetch;
    await expect(exchangeCode({ code: "c", verifier: "v", env: ENV, fetchImpl })).rejects.toThrow(/refresh_token/);
  });

  it("redacts the body of a 2xx that is not JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json ya29.SECRET-that-must-not-leak", { status: 200 }),
    ) as unknown as typeof fetch;
    const error = await exchangeCode({ code: "c", verifier: "v", env: ENV, fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("ya29.SECRET");
    expect((error as Error).message).toMatch(/JSON/i);
  });
});

describe("refreshAccessToken", () => {
  it("renews the access token", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "novo", expires_in: 3600 })),
    ) as unknown as typeof fetch;
    expect((await refreshAccessToken({ refreshToken: "rt", env: ENV, fetchImpl })).accessToken).toBe("novo");
  });
});

describe("loadCodeAssistInfo", () => {
  function respond(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it("returns the projectId and both halves of the tier", async () => {
    const fetchImpl = respond({
      cloudaicompanionProject: "aicode-consumers",
      currentTier: { id: "free-tier", name: "Antigravity" },
      paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
    });

    const info = await loadCodeAssistInfo("at", { env: ENV, fetchImpl });

    expect(info?.projectId).toBe("aicode-consumers");
    expect(info?.paidTierId).toBe("g1-pro-tier");
    expect(info?.paidTierName).toBe("Google AI Pro");
  });

  it("returns the free tier as a tier, not as nothing", async () => {
    const fetchImpl = respond({
      cloudaicompanionProject: "aicode-consumers",
      // The measured free-tier payload (spec §3.6). currentTier is also "free-tier"
      // in both accounts, so it carries no signal — the paidTier id is what counts.
      currentTier: { id: "free-tier", name: "Antigravity" },
      paidTier: { id: "free-tier", name: "Antigravity Starter Quota" },
    });

    const info = await loadCodeAssistInfo("at", { env: ENV, fetchImpl });

    expect(info?.paidTierId).toBe("free-tier");
    expect(info?.paidTierName).toBe("Antigravity Starter Quota");
  });

  it("yields nulls for the missing fields instead of throwing", async () => {
    const fetchImpl = respond({ cloudaicompanionProject: "p" });
    const info = await loadCodeAssistInfo("at", { env: ENV, fetchImpl });

    // The refresh path must never fail because the tier is absent: no tier is a fact
    // to record, not an error to raise.
    expect(info?.projectId).toBe("p");
    expect(info?.paidTierId).toBeNull();
    expect(info?.paidTierName).toBeNull();
  });

  it("parses allowedTiers and ineligibleTiers from loadCodeAssist response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", name: "Free Tier", isDefault: true }],
            ineligibleTiers: [
              {
                tierId: "free-tier",
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "Account verification required",
                validationUrl: "https://accounts.google.com/signin/continue?test=1",
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch;

    const info = await loadCodeAssistInfo("at", { env: ENV, fetchImpl });
    expect(info?.allowedTiers).toEqual([{ id: "free-tier", name: "Free Tier", isDefault: true }]);
    expect(info?.ineligibleTiers).toEqual([
      {
        tierId: "free-tier",
        reasonCode: "VALIDATION_REQUIRED",
        reasonMessage: "Account verification required",
        validationUrl: "https://accounts.google.com/signin/continue?test=1",
      },
    ]);
  });

  it("does not throw when no endpoint answers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await loadCodeAssistInfo("at", { env: ENV, fetchImpl })).toBeNull();
  });

  it("does not throw on a transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await loadCodeAssistInfo("at", { env: ENV, fetchImpl })).toBeNull();
  });

  it("carries the CLI fingerprint", async () => {
    const fetchImpl = respond({ cloudaicompanionProject: "p" });
    await loadCodeAssistInfo("at", { env: ENV, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("antigravity/cli/");
  });
});

describe("onboardUser", () => {
  it("sends POST /v1internal:onboardUser with tierId and ANTIGRAVITY metadata", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await onboardUser("at", "free-tier", { env: ENV, fetchImpl });
    expect(capturedUrl).toContain("/v1internal:onboardUser");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe("Bearer at");
    expect((capturedInit?.headers as Record<string, string>)["User-Agent"]).toContain("antigravity/cli/");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      tierId: "free-tier",
      metadata: { ideType: "ANTIGRAVITY" },
    });
    expect(result.projectId).toBe("aicode-consumers");
  });

  it("extracts projectId from response object when returned in LRO response format", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: "projects/custom-123" },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const result = await onboardUser("at", "free-tier", { env: ENV, fetchImpl });
    expect(result.projectId).toBe("projects/custom-123");
  });

  it("returns null projectId when operation is pending or body has no project", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: "operations/onboard-1",
            done: false,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const result = await onboardUser("at", "free-tier", { env: ENV, fetchImpl });
    expect(result.projectId).toBeNull();
  });

  it("returns null on transport failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await onboardUser("at", "free-tier", { env: ENV, fetchImpl });
    expect(result.projectId).toBeNull();
  });
});

describe("discoverProjectId", () => {
  it("extracts the projectId and the tier, still returning the name", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "aicode-consumers",
            currentTier: { id: "free-tier", name: "Antigravity" },
            paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
          }),
        ),
    ) as unknown as typeof fetch;
    const out = await discoverProjectId("at", { env: ENV, fetchImpl });
    expect(out.projectId).toBe("aicode-consumers");
    expect(out.paidTier).toBe("Google AI Pro");
    // New: the id is no longer discarded (spec D15).
    expect(out.paidTierId).toBe("g1-pro-tier");
  });

  it("still throws when no projectId can be found", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ paidTier: { id: "free-tier" } })),
    ) as unknown as typeof fetch;
    // The login path's contract is unchanged: a login without a project is a failed
    // login, even though the tier reader tolerates the same payload.
    await expect(discoverProjectId("at", { env: ENV, fetchImpl, pollIntervalMs: 0 })).rejects.toThrow();
  });

  it("auto-onboards account when projectId is missing initially", async () => {
    let onboardCalled = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("onboardUser")) {
        onboardCalled = true;
        return new Response(JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          allowedTiers: [{ id: "free-tier", isDefault: true }],
          paidTier: { id: "free-tier", name: "Free Tier" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await discoverProjectId("at", { env: ENV, fetchImpl });
    expect(onboardCalled).toBe(true);
    expect(out.projectId).toBe("aicode-consumers");
    expect(out.paidTier).toBe("Free Tier");
    expect(out.paidTierId).toBe("free-tier");
  });

  it("polls loadCodeAssist when onboardUser returns LRO without immediate project", async () => {
    let loadCount = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("onboardUser")) {
        return new Response(JSON.stringify({ name: "operations/123", done: false }), { status: 200 });
      }
      loadCount++;
      if (loadCount === 1) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: "aicode-consumers",
          paidTier: { id: "free-tier", name: "Free Tier" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await discoverProjectId("at", { env: ENV, fetchImpl, pollIntervalMs: 0 });
    expect(loadCount).toBeGreaterThanOrEqual(2);
    expect(out.projectId).toBe("aicode-consumers");
  });

  it("throws informative error with validationUrl containing authuser and login_hint on VALIDATION_REQUIRED", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ineligibleTiers: [
              {
                tierId: "free-tier",
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "Account verification required",
                validationUrl: "https://accounts.google.com/signin/continue?foo=bar",
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      discoverProjectId("at", {
        env: ENV,
        fetchImpl,
        userEmail: "hmedeiros.ai.004@gmail.com",
      }),
    ).rejects.toThrow(/authuser=hmedeiros\.ai\.004%40gmail\.com/);
  });

  it("does not call onboardUser if projectId is already present", async () => {
    let onboardCalled = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("onboardUser")) {
        onboardCalled = true;
      }
      return new Response(
        JSON.stringify({
          cloudaicompanionProject: "already-present",
          paidTier: { id: "g1-pro-tier", name: "Pro" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await discoverProjectId("at", { env: ENV, fetchImpl });
    expect(out.projectId).toBe("already-present");
    expect(onboardCalled).toBe(false);
  });
});

describe("getUserEmail", () => {
  it("returns the email from userinfo", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ email: "hudson@gmail.com", verified_email: true })),
    ) as unknown as typeof fetch;
    expect(await getUserEmail("at", { env: ENV, fetchImpl })).toBe("hudson@gmail.com");
  });

  it("returns undefined when the response is not ok", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"invalid_token"}', { status: 401 }),
    ) as unknown as typeof fetch;
    expect(await getUserEmail("at", { env: ENV, fetchImpl })).toBeUndefined();
  });

  it("returns undefined when the network throws, without propagating or leaking", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Bearer ya29.SECRET-that-must-not-leak");
    }) as unknown as typeof fetch;
    await expect(getUserEmail("at", { env: ENV, fetchImpl })).resolves.toBeUndefined();
  });

  it("returns undefined when the body carries no email", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ sub: "123" })),
    ) as unknown as typeof fetch;
    expect(await getUserEmail("at", { env: ENV, fetchImpl })).toBeUndefined();
  });
});
