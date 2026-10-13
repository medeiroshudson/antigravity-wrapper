import { describe, expect, it, vi } from "vitest";
import { fetchAvailableModels } from "../src/lib/antigravity/quota.js";

describe("fetchAvailableModels", () => {
  it("extracts one row per model, with the lowest fraction across windows", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: {
              "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-19T20:39:33Z" } },
              "chat_1": { quotaInfo: { remainingFraction: 1 } },
              "gemini-3.8-flash-high": { isInternal: true, quotaInfo: { remainingFraction: 1 } },
            },
          }),
        ),
    ) as unknown as typeof fetch;

    const rows = await fetchAvailableModels({
      accessToken: "t",
      projectId: "p",
      env: { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" },
      fetchImpl,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.modelId).toBe("gemini-3.8-flash-low");
    expect(rows[0]?.remainingFraction).toBe(0.8);
    expect(rows[0]?.window).toBe("model");
  });

  it("returns empty when the endpoint fails, without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(
      await fetchAvailableModels({ accessToken: "t", projectId: "p", env: {}, fetchImpl }),
    ).toEqual([]);
  });
});
