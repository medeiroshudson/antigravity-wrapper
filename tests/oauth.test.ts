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

describe("discoverProjectId", () => {
  it("extracts cloudaicompanionProject and the paidTier", async () => {
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
