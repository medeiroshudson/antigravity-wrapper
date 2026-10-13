import { describe, expect, it, vi } from "vitest";
import { antigravityHeaders, readSse, streamGenerate } from "../src/lib/antigravity/rpc.js";
import { UpstreamError } from "../src/lib/antigravity/errors.js";

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A stream that never delivers data nor closes: exercises stall and abort. */
function silentResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("antigravityHeaders", () => {
  it("includes the fingerprint and the bearer", () => {
    const headers = antigravityHeaders("tok", { userAgent: "ua/1" });
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["User-Agent"]).toBe("ua/1");
  });

  it("omits the user-agent when explicitly null", () => {
    expect(antigravityHeaders("tok", { userAgent: null })["User-Agent"]).toBeUndefined();
  });
});

describe("streamGenerate", () => {
  it("returns the response when 200", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["data: {}\n\n"])) as unknown as typeof fetch;
    expect((await streamGenerate("tok", { a: 1 }, { fetchImpl })).status).toBe(200);
  });

  it("throws a classified UpstreamError on non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(streamGenerate("tok", {}, { fetchImpl })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("does not try the next endpoint on a client error (400)", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"bad"}}', { status: 400 }));
    await expect(
      streamGenerate("tok", {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: "client_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tries the next endpoint on 503", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? new Response("{}", { status: 503 }) : sseResponse(["data: {}\n\n"]);
    }) as unknown as typeof fetch;
    expect((await streamGenerate("tok", {}, { fetchImpl })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("streamGenerate timeouts", () => {
  /** A fetch that only settles when the signal aborts: a backend that accepts and never responds. */
  function hangingFetch(): typeof fetch {
    return vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? undefined;
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ) as unknown as typeof fetch;
  }

  it("aborts with server_error when no headers arrive within the deadline", async () => {
    await expect(
      streamGenerate("tok", {}, { env: { STREAM_HEADER_TIMEOUT_MS: "20" }, fetchImpl: hangingFetch() }),
    ).rejects.toMatchObject({ kind: "server_error" });
  });

  it("aborts with client_error when the caller's signal cancels", async () => {
    const controller = new AbortController();
    const pending = streamGenerate("tok", {}, { fetchImpl: hangingFetch(), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "client_error" });
  });
});

describe("readSse", () => {
  it("delivers the parsed chunks and ignores [DONE]", async () => {
    const response = sseResponse([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"o"}]}}]}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const seen: unknown[] = [];
    for await (const chunk of readSse(response)) seen.push(chunk);
    expect(seen).toHaveLength(1);
  });

  it("does not break on a partial line split across network chunks", async () => {
    const response = sseResponse(['data: {"response":{"cand', 'idates":[]}}\n\n']);
    const seen: unknown[] = [];
    for await (const chunk of readSse(response)) seen.push(chunk);
    expect(seen).toHaveLength(1);
  });

  it("ends the read when the signal aborts", async () => {
    const response = silentResponse();
    const controller = new AbortController();
    const iterate = (async () => {
      for await (const chunk of readSse(response, { signal: controller.signal })) {
        void chunk;
      }
    })();
    // Let the read start before aborting (covers the listener path).
    await Promise.resolve();
    controller.abort();
    await expect(iterate).rejects.toBeInstanceOf(UpstreamError);
  });

  it("ends with an error when the server goes silent (stall watchdog)", async () => {
    const response = silentResponse();
    const iterate = (async () => {
      for await (const chunk of readSse(response, { stallMs: 20 })) {
        void chunk;
      }
    })();
    await expect(iterate).rejects.toBeInstanceOf(UpstreamError);
  });
});
