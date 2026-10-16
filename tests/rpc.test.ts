import { describe, expect, it, vi } from "vitest";
import { antigravityHeaders, readSse, streamGenerate } from "../src/lib/antigravity/rpc.js";
import { ClientDisconnectedError, UpstreamError } from "../src/lib/antigravity/errors.js";
import { captureLogger } from "./fixtures/logger.js";

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

describe("error attribution across endpoints", () => {
  /** Answers each endpoint in order from the given list of responses. */
  function byEndpoint(responses: Array<{ status: number; body: string }>) {
    let call = 0;
    return vi.fn(async () => {
      const step = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return new Response(step?.body ?? "{}", { status: step?.status ?? 500 });
    }) as unknown as typeof fetch;
  }

  const notFound = { status: 404, body: '{"error":{"message":"Requested entity was not found."}}' };
  const exhausted = { status: 429, body: '{"error":{"message":"Quota reached. Resets in 1h."}}' };

  it("reports the primary endpoint's error, not the last one's", async () => {
    // Measured live: daily returned 404 and cloudcode-pa returned 429, and the 429 won,
    // which reported a missing model as a rate limit (spec §3.3).
    const error = await streamGenerate("t", {}, { env: {}, fetchImpl: byEndpoint([notFound, notFound, exhausted]) }).catch((e) => e);
    expect(error.kind).toBe("model_not_found");
    expect(error.status).toBe(404);
  });

  it("stops after the primary's definitive error instead of spending every endpoint", async () => {
    const fetchImpl = byEndpoint([notFound, notFound, exhausted]);
    await streamGenerate("t", {}, { env: {}, fetchImpl }).catch(() => undefined);
    // One request, not three: an id the backend does not have cannot be repaired by
    // trying another channel.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still tries the next endpoint when the failure is repairable", async () => {
    const fetchImpl = byEndpoint([exhausted, notFound]);
    await streamGenerate("t", {}, { env: {}, fetchImpl }).catch(() => undefined);
    // A throttle on the primary is worth a reserve.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the primary's rate limit when a reserve answers 404", async () => {
    const error = await streamGenerate("t", {}, { env: {}, fetchImpl: byEndpoint([exhausted, notFound]) }).catch((e) => e);
    // The reverse of the reported case: a reserve's 404 is not more true than the
    // primary's 429, which is why first-error-wins beats a specificity ranking.
    expect(error.kind).toBe("quota");
    expect(error.status).toBe(429);
  });
});

describe("streamGenerate logging", () => {
  it("records each endpoint answer with its classified kind", async () => {
    const { logger, lines } = captureLogger();
    const rejected = vi.fn(async () => new Response('{"error":{"message":"nope"}}', { status: 404 }));
    await streamGenerate("tok", {}, { logger, fetchImpl: rejected as unknown as typeof fetch }).catch(
      () => undefined,
    );

    const rejectedLine = lines.find((l) => l.msg === "upstream rejected");
    expect(rejectedLine?.level).toBe("warn");
    expect(rejectedLine?.obj.status).toBe(404);
    expect(rejectedLine?.obj.kind).toBe("model_not_found");
    expect(typeof rejectedLine?.obj.endpoint).toBe("string");
    expect(lines.some((l) => l.msg === "upstream exhausted")).toBe(true);
    expect(lines.some((l) => l.msg === "upstream attempt" && l.level === "debug")).toBe(true);
  });

  it("never lets a bearer token reach the upstream detail field", async () => {
    const { logger, lines } = captureLogger();
    const leak = vi.fn(
      async () =>
        new Response('{"error":{"message":"token=ya29.SYNTHETICTOKENVALUE0000"}}', { status: 500 }),
    );
    await streamGenerate("tok", {}, { logger, fetchImpl: leak as unknown as typeof fetch }).catch(
      () => undefined,
    );

    const detail = String(lines.find((l) => l.msg === "upstream rejected")?.obj.detail ?? "");
    expect(detail).not.toContain("ya29.SYNTHETIC");
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

  it("aborts with ClientDisconnectedError when the caller's signal cancels", async () => {
    const controller = new AbortController();
    const pending = streamGenerate("tok", {}, { fetchImpl: hangingFetch(), signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    // The abort is the client's verdict, not the upstream's: a distinct class keeps it
    // out of the definitive-pool machinery (measured: it burned a failover slot and
    // crashed the reply with status 0).
    await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
    await expect(pending).rejects.not.toBeInstanceOf(UpstreamError);
    await expect(pending).rejects.toMatchObject({ status: 499 });
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

  it("ends the read with ClientDisconnectedError when the signal aborts", async () => {
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
    await expect(iterate).rejects.toBeInstanceOf(ClientDisconnectedError);
    await expect(iterate).rejects.not.toBeInstanceOf(UpstreamError);
    await expect(iterate).rejects.toMatchObject({ status: 499 });
  });

  it("ends with an error when the server goes silent (stall watchdog)", async () => {
    const response = silentResponse();
    const iterate = (async () => {
      for await (const chunk of readSse(response, { env: { STREAM_STALL_TIMEOUT_MS: "20" } })) {
        void chunk;
      }
    })();
    await expect(iterate).rejects.toBeInstanceOf(UpstreamError);
  });

  it("reassembles a tool call whose JSON arrives split at any byte boundary", async () => {
    // A tool call is the payload most likely to straddle a chunk: it carries a long
    // thoughtSignature, and the signature is only useful if it survives intact into the
    // next turn. Splitting at many boundaries proves the buffer is not boundary-dependent.
    const frame = `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "get_weather", args: { city: "Paris" } },
                  thoughtSignature: "SIG-328chars-" + "x".repeat(300),
                },
              ],
            },
          },
        ],
      },
    })}\n\n`;

    const whole: unknown[] = [];
    for await (const chunk of readSse(sseResponse([frame]))) whole.push(chunk);

    for (let cut = 1; cut < frame.length; cut += 7) {
      const seen: unknown[] = [];
      for await (const chunk of readSse(sseResponse([frame.slice(0, cut), frame.slice(cut)]))) {
        seen.push(chunk);
      }
      expect(seen, `split at byte ${cut}`).toEqual(whole);
    }
  });

  it("keeps the whole thoughtSignature when the split falls inside it", async () => {
    const signature = "SIG-" + "abcdefghij".repeat(30);
    const line = `data: ${JSON.stringify({
      response: {
        candidates: [
          { content: { parts: [{ functionCall: { name: "t", args: {} }, thoughtSignature: signature }] } },
        ],
      },
    })}\n\n`;

    // Cut inside the signature itself -- where a buffer that reset per chunk would
    // silently truncate the token and break multi-turn tool calling.
    const at = line.indexOf(signature) + Math.floor(signature.length / 2);
    const seen: Array<{ response?: { candidates?: Array<{ content?: { parts?: Array<{ thoughtSignature?: string }> } }> } }> = [];
    for await (const chunk of readSse(sseResponse([line.slice(0, at), line.slice(at)]))) {
      seen.push(chunk as never);
    }

    const parts = seen[0]?.response?.candidates?.[0]?.content?.parts ?? [];
    expect(parts[0]?.thoughtSignature).toBe(signature);
  });
});
