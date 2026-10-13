import { describe, expect, it, vi } from "vitest";
import { AllAccountsFailedError, TurnRunner } from "../src/lib/chat/turn.js";
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

const TEXT_SSE = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ola"}]}}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}}\n\n',
  "data: [DONE]\n\n",
];

function service(accounts: AccountSnapshot[]): AccountService {
  return {
    orderFor: vi.fn(async () => accounts),
    ensureFresh: vi.fn(async (a: AccountSnapshot) => a),
    markUsed: vi.fn(),
    applyFailure: vi.fn(),
    // The runner fires a best-effort quota refresh after a 429 (spec §9.3).
    refreshQuota: vi.fn(async () => undefined),
  } as unknown as AccountService;
}

const BASE = {
  runtimeModel: "gemini-3.8-flash-low",
  contents: [{ role: "user" as const, parts: [{ text: "oi" }] }],
  systemInstruction: "sys",
  effort: "off" as const,
};

describe("TurnRunner", () => {
  it("runs the turn and returns text, usage and finish reason", async () => {
    const fetchImpl = vi.fn(async () => sse(TEXT_SSE)) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const { result, accountId } = await runner.run(BASE);
    expect(accountId).toBe("a1");
    expect(result.content).toBe("ola");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
  });

  it("emits deltas through onDelta", async () => {
    const fetchImpl = vi.fn(async () => sse(TEXT_SSE)) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const deltas: string[] = [];
    await runner.run(BASE, { onDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(["ola"]);
  });

  it("fails over to the next account when the first returns a 429 quota", async () => {
    // `streamGenerate` tries the three endpoints per account: the fake transport must
    // reject the ENTIRE first account (all endpoints) and only then accept the
    // second, otherwise the failover never even happens. The account is identified by
    // the bearer in the header, not by the call count.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      return auth.includes("tok-a1")
        ? new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 })
        : sse(TEXT_SSE);
    }) as unknown as typeof fetch;
    const accounts = service([snapshot("a1"), snapshot("a2")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    const { accountId } = await runner.run(BASE);
    expect(accountId).toBe("a2");
    expect(accounts.applyFailure).toHaveBeenCalledTimes(1);
  });

  it("does not fail over on 400 (client error)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Invalid JSON payload"}}', { status: 400 }),
    ) as unknown as typeof fetch;
    const accounts = service([snapshot("a1"), snapshot("a2")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    await expect(runner.run(BASE)).rejects.toMatchObject({ kind: "client_error" });
    expect(accounts.applyFailure).not.toHaveBeenCalled();
  });

  it("throws AllAccountsFailedError with each account's reason", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1"), snapshot("a2")]), fetchImpl });
    await expect(runner.run(BASE)).rejects.toBeInstanceOf(AllAccountsFailedError);
  });

  it("throws AllAccountsFailedError when the pool is empty", async () => {
    const runner = new TurnRunner({ accounts: service([]), fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(runner.run(BASE)).rejects.toBeInstanceOf(AllAccountsFailedError);
  });

  it("respects the attempt cap", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    const many = [snapshot("a1"), snapshot("a2"), snapshot("a3"), snapshot("a4")];
    const accounts = service(many);
    const runner = new TurnRunner({
      accounts,
      fetchImpl,
      env: { MAX_FAILOVER_ATTEMPTS: "2" },
    });
    await expect(runner.run(BASE)).rejects.toBeInstanceOf(AllAccountsFailedError);
    // Two account attempts (not four), regardless of how many endpoints each one
    // traverses.
    expect(accounts.applyFailure).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an already-tried account", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    const accounts = service([snapshot("a1")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    await expect(runner.run(BASE)).rejects.toBeInstanceOf(AllAccountsFailedError);
    // A single account in the pool: a single attempt.
    expect(accounts.applyFailure).toHaveBeenCalledTimes(1);
  });

  it("extracts tool calls from the response", async () => {
    const toolSse = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"},"id":"call_1"},"thoughtSignature":"SIG"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn(async () => sse(toolSse)) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const { result } = await runner.run(BASE);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls[0]?.thoughtSignature).toBe("SIG");
  });

  it("fails when the stream ends without finishReason", async () => {
    // Without `onDelta` (stream:false) a truncated stream is recoverable and falls
    // through to the next account; with a single account the result is
    // AllAccountsFailedError, but the reason's classification is still server_error.
    const fetchImpl = vi.fn(async () =>
      sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"parcial"}]}}]}}\n\n']),
    ) as unknown as typeof fetch;
    const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
    const error = await runner.run(BASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllAccountsFailedError);
    expect((error as AllAccountsFailedError).failures[0]?.kind).toBe("server_error");
  });

  it("with stream:false, an error mid-generation fails over to the next account", async () => {
    // The first account emits text and dies without finishReason (recoverable error);
    // since nothing reached the client until the final JSON, the second account is tried.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      return auth.includes("tok-a1")
        ? sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"parcial"}]}}]}}\n\n'])
        : sse(TEXT_SSE);
    }) as unknown as typeof fetch;
    const accounts = service([snapshot("a1"), snapshot("a2")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    const { accountId, result } = await runner.run(BASE);
    expect(accountId).toBe("a2");
    expect(result.content).toBe("ola");
  });

  it("in stream mode, after a delta is emitted, does not switch accounts (fatal after content)", async () => {
    const fetchImpl = vi.fn(async () =>
      sse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"parcial"}]}}]}}\n\n']),
    ) as unknown as typeof fetch;
    const accounts = service([snapshot("a1"), snapshot("a2")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    const deltas: string[] = [];
    await expect(runner.run(BASE, { onDelta: (t) => deltas.push(t) })).rejects.toMatchObject({
      kind: "server_error",
    });
    // The second account was never tried: the delta was already on the wire.
    expect(accounts.applyFailure).not.toHaveBeenCalled();
  });

  it("maps SAFETY and RECITATION to content_filter", async () => {
    for (const [raw, expected] of [
      ["STOP", "stop"],
      ["MAX_TOKENS", "length"],
      ["SAFETY", "content_filter"],
      ["RECITATION", "content_filter"],
    ] as const) {
      const fetchImpl = vi.fn(async () =>
        sse([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"oi"}]}}]}}\n\n',
          `data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"${raw}"}]}}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ) as unknown as typeof fetch;
      const runner = new TurnRunner({ accounts: service([snapshot("a1")]), fetchImpl });
      const { result } = await runner.run(BASE);
      expect(result.finishReason).toBe(expected);
    }
  });

  it("a 429 triggers a best-effort quota refresh of the affected account", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    const accounts = service([snapshot("a1")]);
    const runner = new TurnRunner({ accounts, fetchImpl });
    await runner.run(BASE).catch(() => undefined);
    expect(accounts.refreshQuota).toHaveBeenCalledWith("a1");
  });
});
