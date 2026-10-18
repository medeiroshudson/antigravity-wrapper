import { describe, expect, it, vi } from "vitest";
import { TurnRunner } from "../src/lib/chat/turn.js";
import type { AccountService } from "../src/lib/accounts/service.js";
import type { AccountSnapshot } from "../src/lib/accounts/store.js";

function snapshot(id: string): AccountSnapshot {
  return {
    id,
    email: `${id}@x.com`,
    refreshToken: "r",
    accessToken: `tok-${id}`,
    accessExpiresAt: Date.now() + 3_600_000,
    projectId: "p",
    status: "active",
    cooldownUntil: null,
    lastError: null,
    quotaSummaryError: null,
    paidTierId: null,
    paidTierName: null,
    enabled: true,
    priority: 0,
    createdAt: 0,
    lastUsedAt: null,
    quota: [],
  };
}

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function service(accounts: AccountSnapshot[]): AccountService {
  return {
    orderFor: vi.fn(async () => accounts),
    ensureFresh: vi.fn(async (a: AccountSnapshot) => a),
    markUsed: vi.fn(),
    applyFailure: vi.fn(),
    refreshQuota: vi.fn(async () => undefined),
  } as unknown as AccountService;
}

const BASE = {
  runtimeModel: "gemini-3.8-flash-low",
  contents: [{ role: "user" as const, parts: [{ text: "oi" }] }],
  systemInstruction: "sys",
  effort: "off" as const,
};

describe("Safety block visibility", () => {
  it("returns finish_reason content_filter when promptFeedback indicates blocked prompt", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        'data: {"response":{"promptFeedback":{"blockReason":"SAFETY"}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const { result } = await runner.run(BASE);
    expect(result.finishReason).toBe("content_filter");
    expect(result.content).toBe("");
    expect(result.blockedReason).toBe("SAFETY");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        field: "promptFeedback",
        reason: expect.stringContaining("SAFETY"),
      }),
    );
  });

  it("discards partial content if promptFeedback blockReason arrives", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial content"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"finishReason":"SAFETY","promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}]}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const { result } = await runner.run(BASE);
    expect(result.finishReason).toBe("content_filter");
    expect(result.content).toBe("");
    expect(result.blockedReason).toBe("PROHIBITED_CONTENT");
  });

  it("prefers content_filter over tool_calls when finishReason is SAFETY or RECITATION", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"a":1}},"thoughtSignature":"SIG"}]},"finishReason":"SAFETY"}]}}\n\n',
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const { result } = await runner.run(BASE);
    expect(result.finishReason).toBe("content_filter");
  });
});
