import { describe, expect, it, vi } from "vitest";
import { fetchAvailableModels, retrieveUserQuotaSummary } from "../src/lib/antigravity/quota.js";

const ENV = {
  ANTIGRAVITY_CLIENT_ID: "c",
  ANTIGRAVITY_CLIENT_SECRET: "s",
  ANTIGRAVITY_PROJECT_ID: "p",
};

/** The measured payload, verbatim shape (spec §3.1). */
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
          description:
            "You have used some of your weekly limit, it will fully refresh in 5 days, 21 hours.",
          remainingFraction: 0.99093425,
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-10-14T03:07:40Z",
          description:
            "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 59 minutes.",
          remainingFraction: 0.9883959,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        {
          bucketId: "3p-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-10-20T14:11:18Z",
          remainingFraction: 0.97851,
        },
        {
          bucketId: "3p-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-10-14T03:26:28Z",
          remainingFraction: 0.974784,
        },
      ],
    },
  ],
  description: "Within each group, models share a weekly limit and a 5-hour limit.",
};

/** The measured subscription 403, verbatim (spec §3.4). */
const SUBSCRIPTION_403 = {
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    message:
      "You do not have a valid license of this product. Please contact your administrator to request a license. If you are not an enterprise user and believe you are receiving this message as an error, please try using the latest version and logging in again. (#3501)",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SUBSCRIPTION_REQUIRED",
        domain: "cloudaicompanion.googleapis.com",
        metadata: { uiMessage: "true", error_number: "1001" },
      },
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        links: [
          {
            description: "Learn more",
            url: "https://cloud.google.com/gemini/docs/codeassist/request-license",
          },
        ],
      },
    ],
  },
};

function respond(body: unknown, init: ResponseInit = {}) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200, ...init }),
  ) as unknown as typeof fetch;
}

describe("retrieveUserQuotaSummary", () => {
  it("flattens the groups into one row per bucket, in the backend's order", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond(SUMMARY),
    });

    expect(result.failure).toBeNull();
    expect(result.rows.map((row) => row.bucketId)).toEqual([
      "gemini-weekly",
      "gemini-5h",
      "3p-weekly",
      "3p-5h",
    ]);
  });

  it("maps names, windows, fractions, descriptions and resets", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond(SUMMARY),
    });
    const weekly = result.rows[0];

    expect(weekly?.groupName).toBe("Gemini Models");
    expect(weekly?.groupDescription).toBe("Models within this group: Gemini Flash, Gemini Pro");
    expect(weekly?.displayName).toBe("Weekly Limit Remaining");
    expect(weekly?.window).toBe("weekly");
    expect(weekly?.bucketDescription).toContain("fully refresh in 5 days");
    expect(weekly?.remainingFraction).toBe(0.99093425);
    expect(weekly?.resetAt).toBe(Date.parse("2026-10-19T20:43:54Z"));
    expect(typeof weekly?.fetchedAt).toBe("number");
  });

  it("sends an empty body, never metadata", async () => {
    const fetchImpl = respond(SUMMARY);
    await retrieveUserQuotaSummary({ accessToken: "t", env: ENV, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The RPC rejects metadata with a 400 (spec §3.2): the body must be exactly {}.
    expect(init.body).toBe("{}");
    expect(String(init.body)).not.toContain("metadata");
  });

  it("classifies the subscription 403 by its detail, not by its message", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond(SUBSCRIPTION_403, { status: 403 }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failure?.reason).toBe("subscription_required");
    expect(result.failure?.detail).toContain("valid license");
  });

  it("does NOT call the identical message a subscription problem when the detail is absent", async () => {
    // The missing-CLI-fingerprint 403 carries the same message text but no
    // SUBSCRIPTION_REQUIRED detail; it is a wrapper misconfiguration, not the account.
    const fingerprint403 = {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: SUBSCRIPTION_403.error.message,
      },
    };
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond(fingerprint403, { status: 403 }),
    });

    expect(result.failure?.reason).toBe("unavailable");
  });

  it("reports another failure as generically unavailable", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond({ error: { message: "boom" } }, { status: 500 }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failure?.reason).toBe("unavailable");
    expect(result.failure?.detail).toContain("boom");
  });

  it("reports no failure when nothing answered at all", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await retrieveUserQuotaSummary({ accessToken: "t", env: ENV, fetchImpl });

    expect(result.rows).toEqual([]);
    // Nothing answered, so there is no reason to quote (spec §11).
    expect(result.failure).toBeNull();
  });

  it("clamps a fraction outside 0..1 instead of trusting it", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1.5 },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: -0.2 },
            ],
          },
        ],
      }),
    });

    expect(result.rows.map((row) => row.remainingFraction)).toEqual([1, 0]);
  });

  it("leaves resetAt null when resetTime is absent or unparseable", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 },
              { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: "nao e data" },
            ],
          },
        ],
      }),
    });

    expect(result.rows.map((row) => row.resetAt)).toEqual([null, null]);
  });

  it("drops a bucket with no id and one with no fraction", async () => {
    const result = await retrieveUserQuotaSummary({
      accessToken: "t",
      env: ENV,
      fetchImpl: respond({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { window: "weekly", remainingFraction: 0.5 },
              { bucketId: "gemini-5h", window: "5h" },
            ],
          },
        ],
      }),
    });

    expect(result.rows).toEqual([]);
  });

  it("carries the CLI fingerprint", async () => {
    const fetchImpl = respond(SUMMARY);
    await retrieveUserQuotaSummary({ accessToken: "t", env: ENV, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("antigravity/cli/");
  });
});

describe("fetchAvailableModels", () => {
  it("returns the usable model ids and reads no quota", async () => {
    const fetchImpl = respond({
      models: {
        "gemini-3.8-flash-low": {
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-19T20:39:33Z" },
        },
        chat_1: { quotaInfo: { remainingFraction: 1 } },
        "gemini-3.8-flash-high": { isInternal: true, quotaInfo: { remainingFraction: 1 } },
        "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.97 } },
      },
    });

    const ids = await fetchAvailableModels({ accessToken: "t", projectId: "p", env: ENV, fetchImpl });

    // The per-model quota is gone on purpose: it reproduced one window per model and
    // hid the weekly one (spec §3.3).
    expect(ids).toEqual(["gemini-3.8-flash-low", "claude-opus-4-6-thinking"]);
  });

  it("returns empty when the endpoint fails, without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchAvailableModels({ accessToken: "t", projectId: "p", env: {}, fetchImpl })).toEqual(
      [],
    );
  });
});
