import { describe, expect, it, vi } from "vitest";
import { FallbackQuotaStrategy } from "../src/lib/antigravity/quota-strategies/fallback.js";
import { CatalogQuotaStrategy } from "../src/lib/antigravity/quota-strategies/catalog.js";
import { createQuotaStrategy } from "../src/lib/antigravity/quota-strategies/registry.js";
import { SummaryQuotaStrategy } from "../src/lib/antigravity/quota-strategies/summary.js";

const ENV = {
  ANTIGRAVITY_CLIENT_ID: "c",
  ANTIGRAVITY_CLIENT_SECRET: "s",
  ANTIGRAVITY_PROJECT_ID: "p",
};

const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.9,
        },
      ],
    },
  ],
};

const CATALOG = {
  models: {
    "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.35, resetTime: "2026-10-19T20:39:33Z" } },
    "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 0.7 } },
  },
};

const SUBSCRIPTION_403 = {
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    message: "You do not have a valid license of this product. (#3501)",
    details: [{ reason: "SUBSCRIPTION_REQUIRED", domain: "cloudaicompanion.googleapis.com" }],
  },
};

/** Answers the catalog and the summary from one stub, in any order. */
function upstream(
  opts: { catalog?: unknown; catalogStatus?: number; summary?: unknown; summaryStatus?: number } = {},
) {
  return vi.fn(async (url: string) => {
    if (url.includes("fetchAvailableModels")) {
      return new Response(JSON.stringify(opts.catalog ?? CATALOG), {
        status: opts.catalogStatus ?? 200,
      });
    }
    return new Response(JSON.stringify(opts.summary ?? SUMMARY), {
      status: opts.summaryStatus ?? 200,
    });
  }) as unknown as typeof fetch;
}

function summaryCalled(fetchImpl: typeof fetch): boolean {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
    String(call[0]).includes("retrieveUserQuotaSummary"),
  );
}

const CTX = { accessToken: "t", projectId: "p", env: ENV };

describe("SummaryQuotaStrategy", () => {
  it("returns the summary buckets", async () => {
    const result = await new SummaryQuotaStrategy().fetch({
      ...CTX,
      fetchImpl: upstream(),
    });

    expect(result.rows.map((row) => row.bucketId)).toEqual(["gemini-weekly"]);
    expect(result.failure).toBeNull();
  });

  it("passes the summary failure through", async () => {
    const result = await new SummaryQuotaStrategy().fetch({
      ...CTX,
      fetchImpl: upstream({ summary: SUBSCRIPTION_403, summaryStatus: 403 }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failure?.reason).toBe("subscription_required");
  });
});

describe("CatalogQuotaStrategy", () => {
  it("uses the catalog quota the caller already read, with no HTTP call", async () => {
    const rows = [{ bucketId: "gemini-models" }] as never;
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await new CatalogQuotaStrategy().fetch({ ...CTX, catalogQuota: rows, fetchImpl });

    expect(result).toEqual({ rows, failure: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the catalog when the caller has no quota yet", async () => {
    const result = await new CatalogQuotaStrategy().fetch({ ...CTX, fetchImpl: upstream() });

    expect(result.rows.map((row) => row.bucketId)).toEqual(["gemini-models", "3p-models"]);
    expect(result.rows[0]?.remainingFraction).toBe(0.35);
  });
});

describe("FallbackQuotaStrategy", () => {
  it("keeps the paid summary over the catalog", async () => {
    const result = await new FallbackQuotaStrategy().fetch({
      ...CTX,
      fetchImpl: upstream(),
    });

    expect(result.rows.map((row) => row.bucketId)).toEqual(["gemini-weekly"]);
  });

  it("falls back to the catalog when the summary is denied", async () => {
    const result = await new FallbackQuotaStrategy().fetch({
      ...CTX,
      fetchImpl: upstream({ summary: SUBSCRIPTION_403, summaryStatus: 403 }),
    });

    expect(result.rows.map((row) => row.bucketId)).toEqual(["gemini-models", "3p-models"]);
    expect(result.failure).toBeNull();
  });

  it("never asks for the summary when the account is known to be free-tier", async () => {
    const fetchImpl = upstream({ summary: SUBSCRIPTION_403, summaryStatus: 403 });

    const result = await new FallbackQuotaStrategy().fetch({
      ...CTX,
      isFreeTier: true,
      fetchImpl,
    });

    expect(result.rows.map((row) => row.bucketId)).toEqual(["gemini-models", "3p-models"]);
    expect(summaryCalled(fetchImpl)).toBe(false);
  });

  it("keeps the last failure when no strategy produces rows", async () => {
    const result = await new FallbackQuotaStrategy().fetch({
      ...CTX,
      fetchImpl: upstream({
        summary: SUBSCRIPTION_403,
        summaryStatus: 403,
        catalog: { models: {} },
      }),
    });

    expect(result.rows).toEqual([]);
    expect(result.failure?.reason).toBe("subscription_required");
  });
});

describe("createQuotaStrategy", () => {
  it("defaults to the fallback and honours the named strategies", () => {
    expect(createQuotaStrategy().name).toBe("auto");
    expect(createQuotaStrategy("summary").name).toBe("summary");
    expect(createQuotaStrategy("catalog").name).toBe("catalog");
  });
});
