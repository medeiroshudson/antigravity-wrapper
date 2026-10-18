import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { applyCatalog, resetRegistryForTests } from "../src/config/models.js";
import { CATALOG } from "./fixtures/catalog.js";

const auth = { authorization: "Bearer test-key" };
const ENV = { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" };
let app: FastifyInstance;
let store: AccountStore;

function seed(id = "a1") {
  store.upsertAccount({
    id,
    email: `${id}@x.com`,
    refreshToken: "r",
    accessToken: "tok",
    accessExpiresAt: Date.now() + 3_600_000,
    projectId: "aicode-consumers",
  });
}

const TEXT_SSE = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ola"}]}}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}}\n\n',
  "data: [DONE]\n\n",
].join("");

function fetchOk(body = TEXT_SSE): typeof fetch {
  return vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Captures the body sent upstream to inspect the systemInstruction. */
function fetchCapture(): {
  fetchImpl: typeof fetch;
  envelope: () => Record<string, unknown> | null;
} {
  let captured: Record<string, unknown> | null = null;
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(TEXT_SSE));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, envelope: () => captured };
}

function systemText(envelope: Record<string, unknown> | null): string {
  const request = (envelope?.request ?? {}) as {
    systemInstruction?: { parts?: Array<{ text?: string }> };
  };
  return request.systemInstruction?.parts?.[0]?.text ?? "";
}

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Clima",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};

beforeEach(() => {
  store = new AccountStore(":memory:");
  // The registry no longer has a static fallback list, so the route's model guard rejects
  // every id until a catalog is applied. This is the catalog for the whole file; the tests
  // that need a different one apply it themselves.
  applyCatalog(CATALOG);
  seed();
});

afterEach(async () => {
  await app.close();
  store.close();
  resetRegistryForTests();
});

describe("POST /v1/chat/completions", () => {
  it("returns a completion with stream:false", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "oi" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("ola");
  });

  it("returns 404 for an unknown model", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "does-not-exist", messages: [{ role: "user", content: "oi" }] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "model_not_found",
    });
  });

  it("returns 400 invalid_request_error when reasoning_effort is an unrecognized string", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        reasoning_effort: "super-high",
        messages: [{ role: "user", content: "oi" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
    });
    expect(response.json().error.message).toMatch(/Invalid reasoning_effort/);
  });

  it("returns a non-retryable 400 when the pool is empty", async () => {
    // An empty pool (every account removed, or all in cooldown) is not a transient server
    // fault: a retryable 503 kept the client re-issuing forever. 400 makes it stop.
    store.removeAccount("a1");
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "oi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/no account in the pool can serve it/i);
  });

  it("returns a non-retryable 400 when the pool is empty, even for stream:true", async () => {
    // The 4e93d50 fix: a drained/empty pool must answer a status the client treats as
    // final. Instant failures still keep real HTTP statuses under the flush patience.
    store.removeAccount("a1");
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/no account in the pool can serve it/i);
  });

  it("returns 400 when messages is empty", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("emits SSE with role in the first chunk and [DONE] at the end", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "oi" }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain("data: [DONE]");
  });
});

describe("tool_choice emulation in the prompt", () => {
  async function post(payload: Record<string, unknown>): Promise<{
    status: number;
    system: () => string;
  }> {
    const capture = fetchCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: capture.fetchImpl, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload,
    });
    return { status: response.statusCode, system: () => systemText(capture.envelope()) };
  }

  it("none instructs not to call any tool", async () => {
    const { status, system } = await post({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "oi" }],
      tools: [WEATHER_TOOL],
      tool_choice: "none",
    });
    expect(status).toBe(200);
    expect(system()).toMatch(/do not call any tool/i);
  });

  it("required injects the instruction, without a fence", async () => {
    const { status, system } = await post({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "oi" }],
      tools: [WEATHER_TOOL],
      tool_choice: "required",
    });
    expect(status).toBe(200);
    expect(system()).toMatch(/exactly one/i);
    expect(system()).not.toContain("```");
  });

  it("a named function instructs to call it, without a fence", async () => {
    const { status, system } = await post({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "oi" }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(status).toBe(200);
    expect(system()).toContain("get_weather");
    expect(system()).not.toContain("```");
  });

  it("auto/absent does not inject a tool instruction", async () => {
    const { status, system } = await post({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "oi" }],
      tools: [WEATHER_TOOL],
    });
    expect(status).toBe(200);
    expect(system()).not.toMatch(/Available tools|Do not call any tool/i);
  });
});

const TOOL_SSE = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"},"id":"call_1"},"thoughtSignature":"SIG-328chars"}]}}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\n',
  "data: [DONE]\n\n",
].join("");

/** Captures every envelope sent upstream and replies with a signed tool call. */
function fetchToolCapture(): {
  fetchImpl: typeof fetch;
  envelopes: Array<Record<string, unknown>>;
} {
  const envelopes: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (_url: string, init?: RequestInit) => {
    envelopes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(TOOL_SSE));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, envelopes };
}

function modelParts(envelope: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const request = (envelope?.request ?? {}) as {
    contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  };
  const model = request.contents?.find((c) => c.role === "model");
  return model?.parts ?? [];
}

describe("thoughtSignature on the OpenAI surface", () => {
  it("round-trips: returns it in the response and resends it in the second turn's envelope", async () => {
    const { fetchImpl, envelopes } = fetchToolCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    // Turn 1: requests the tool; the response carries the signature in an extra field.
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "clima em Paris?" }],
        tools: [WEATHER_TOOL],
      },
    });
    expect(first.statusCode).toBe(200);
    const message = first.json().choices[0].message as {
      content: null;
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string }; thoughtSignature?: string }>;
    };
    const call = message.tool_calls[0]!;
    expect(call.thoughtSignature).toBe("SIG-328chars");

    // Turn 2: built from the body of turn 1's response.
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "clima em Paris?" },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, name: "get_weather", content: '{"temp":20}' },
        ],
        tools: [WEATHER_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);

    const functionCallPart = modelParts(envelopes[1]).find((part) => part.functionCall);
    expect(functionCallPart?.thoughtSignature).toBe("SIG-328chars");
  });

  it("restores the signature server-side when the client drops the non-standard field", async () => {
    // Claude Code and other OpenAI clients do not echo `thoughtSignature` back: the
    // wrapper is the stateful party of the loop, so it must remember the signature it
    // returned and reattach it, or the native Gemini path rejects the next turn with
    // 400 "missing a thought_signature" (measured with the real client).
    const { fetchImpl, envelopes } = fetchToolCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    // Turn 1: get a signed call.
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "clima em Paris?" }],
        tools: [WEATHER_TOOL],
      },
    });
    const call = first.json().choices[0].message.tool_calls[0] as { id: string };

    // Turn 2: the client echoes the call WITHOUT the thoughtSignature field.
    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "clima em Paris?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: call.id, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
          },
          { role: "tool", tool_call_id: call.id, name: "get_weather", content: '{"temp":20}' },
        ],
        tools: [WEATHER_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);

    const functionCallPart = modelParts(envelopes[1]).find((part) => part.functionCall);
    expect(functionCallPart?.thoughtSignature).toBe("SIG-328chars");
  });

  it("emits the signature in the stream's tool_calls delta", async () => {
    const { fetchImpl } = fetchToolCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        tools: [WEATHER_TOOL],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"thoughtSignature":"SIG-328chars"');
  });
});

describe("discovered catalog", () => {
  it("makes a discovered model selectable and visible in /v1/models after the refresh", async () => {
    // An id the file-level CATALOG does not contain, so the assertions below pass only if
    // the refresh really fed the registry: with an id that beforeEach already supplies,
    // this test would keep passing after `applyCatalog` was removed from `refreshQuota`.
    const catalog = {
      models: {
        "gemini-3.6-flash-low": { displayName: "Gemini 3.6 Flash (Low)", maxTokens: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, thinkingBudget: 1000, quotaInfo: { remainingFraction: 1 } },
      },
    };
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("fetchAvailableModels")) return new Response(JSON.stringify(catalog));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(TEXT_SSE));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });

    const refresh = await app.inject({
      method: "POST",
      url: "/admin/accounts/a1/refresh",
      headers: auth,
    });
    expect(refresh.statusCode).toBe(200);

    const models = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const ids = (models.json().data as Array<{ id: string }>).map((m) => m.id);
    // Introduced by the refresh alone.
    expect(ids).toContain("gemini-3.6-flash");
    // Still present from the file-level catalog: the registry accumulates rather than replaces.
    expect(ids).toContain("gemini-3.8-flash");
    // The runtime id is never advertised; only its public form.
    expect(ids).not.toContain("gemini-3.6-flash-low");

    // Before the refresh the public id would 404; now the route accepts it and resolves
    // it to the runtime id that actually exists.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.6-flash", messages: [{ role: "user", content: "oi" }] },
    });
    expect(chat.statusCode).toBe(200);
  });
});

/**
 * Transport regression. On a real socket, Fastify's `request.signal` aborts the
 * instant the request body finishes being read (~0ms) — not when the client
 * disconnects. Chaining that signal in the non-stream path cancelled the upstream
 * call before it left.
 *
 * The other tests miss this for two reasons combined: they use `app.inject()`,
 * which does not produce the real socket `close`, and they inject a `fetchImpl`
 * that ignores `init.signal`. Here the socket is real and the fetch honors the
 * signal, like the native one.
 */
describe("POST /v1/chat/completions over real HTTP", () => {
  it("does not cancel the upstream call due to Fastify's signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(TEXT_SSE));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no ephemeral port");
    const port = address.port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("ola");
  });

  it("a disconnect during the upstream turn logs an abort, not a crash", async () => {
    // The incident (2026-10-16 15:06): the client hung up mid-retry, the abort became a
    // status-0 client_error and the route called reply.status(0) -> FST_ERR_BAD_STATUS_CODE
    // -> 500. Here the socket is real and the fetch honors the signal, like the native one.
    const { logger, entries } = captureFastifyLog();
    const signalSeen = new Promise<AbortSignal>((resolve) => {
      let settled = false;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        if (signal && !settled) {
          settled = true;
          resolve(signal);
        }
        // Hold the request open until the client's disconnect aborts it.
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }) as unknown as typeof fetch;
      app = buildServer("test-key", { store, env: ENV, fetchImpl, logger });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no ephemeral port");
    const port = address.port;

    // A raw socket, killed mid-turn: the closest shape to the incident's vanished client.
    const payload = JSON.stringify({
      stream: false,
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { ...auth, "content-type": "application/json", "content-length": String(payload.length) },
      },
      () => undefined,
    );
    // req.destroy() surfaces as ECONNRESET on this side: expected, not a failure.
    req.on("error", () => undefined);
    req.write(payload);
    req.end();
    const upstreamSignal = await signalSeen;
    const upstreamAborted = new Promise<void>((resolve) => {
      if (upstreamSignal.aborted) resolve();
      else upstreamSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    // Kill the socket the way a vanished client does: raw TCP death, not a graceful
    // end. Aborting an undici fetch instead surfaces an internal unhandled rejection.
    req.destroy();
    await upstreamAborted;

    // The handler runs after the socket is gone; wait for its verdict to hit the log,
    // then require an abort line — never the request-failed 500 the status-0 path produced.
    const deadline = Date.now() + 2_000;
    let logs: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      logs = entries();
      if (logs.some((e) => e.msg === "client disconnected") || logs.some((e) => e.msg === "request failed")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(logs.filter((e) => e.msg === "request failed")).toHaveLength(0);
    expect(logs.filter((e) => e.msg === "chat failed")).toHaveLength(0);
    expect(logs.filter((e) => e.msg === "client disconnected")).toHaveLength(1);
  });
});

describe("the stream flush patience", () => {
  /** Every SSE `data:` frame in the body, parsed. */
  function frames(body: string): Array<Record<string, unknown>> {
    return body
      .split("\n\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
  }

  it("holds the headers back so instant failures keep their real status (stream:true, unknown model)", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "does-not-exist",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it("flushes the SSE head after the patience so a slow upstream cannot starve the client", async () => {
    // With patience 0 the head goes out immediately even though the upstream never
    // answers — proven on a real socket, where the fetch resolves on headers alone.
    // (app.inject would wait for the whole body, which never arrives.)
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    app = buildServer("test-key", {
      store,
      env: { ...ENV, STREAM_FLUSH_PATIENCE_MS: "0" },
      fetchImpl,
      logger: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no ephemeral port");
    const port = address.port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      }),
    });

    // Headers are on the wire while the upstream is still pending.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const firstFrame = (await response.body!.getReader().read()).value;
    const text = new TextDecoder().decode(firstFrame);
    const parsed = JSON.parse(text.replace(/^data: /, "").trim()) as {
      choices: Array<{ delta: { role?: string; content?: string } }>;
    };
    // The OpenAI shape: the leading delta announces the role.
    expect(parsed.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    // Restore: end the hanging response so afterEach can close the app.
    await response.body!.cancel().catch(() => undefined);
    app.server.closeAllConnections();
  });

  it("flushes via the timer when the patience is positive, not just at zero", async () => {
    // The default path: a nonzero patience arms a timer. This is the branch the 0-ms
    // test cannot reach, and the one the incident actually needed (the client waits
    // out the retry ladder with the head on the wire).
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    app = buildServer("test-key", {
      store,
      env: { ...ENV, STREAM_FLUSH_PATIENCE_MS: "50" },
      fetchImpl,
      logger: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no ephemeral port");
    const port = address.port;

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      }),
    });

    expect(response.status).toBe(200);
    const firstFrame = (await response.body!.getReader().read()).value;
    const parsed = JSON.parse(new TextDecoder().decode(firstFrame).replace(/^data: /, "").trim()) as {
      choices: Array<{ delta: { role?: string; content?: string } }>;
    };
    expect(parsed.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    await response.body!.cancel().catch(() => undefined);
    app.server.closeAllConnections();
  });

  it("a slow pre-content failure arrives as an error frame with [DONE], not a hung stream", async () => {
    const rejected = vi.fn(
      async () => new Response('{"error":{"message":"Quota reached. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", {
      store,
      env: { ...ENV, STREAM_FLUSH_PATIENCE_MS: "0" },
      fetchImpl: rejected,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    const all = frames(response.body);
    const errorFrame = all.find((f) => f.error !== undefined);
    expect(errorFrame?.error?.message).toBeTruthy();
    expect(response.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("a normal stream starts with the role frame and never repeats the role", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "oi" }],
      },
    });
    const all = frames(response.body);
    const first = all[0]?.choices?.[0]?.delta as Record<string, unknown> | undefined;
    expect(first?.role).toBe("assistant");
    const roleRepeats = all.slice(1).filter((f) => {
      const delta = f.choices?.[0]?.delta as Record<string, unknown> | undefined;
      return delta?.role !== undefined;
    });
    expect(roleRepeats).toHaveLength(0);
  });
});

describe("the OpenAI surface keeps the OpenAI date contract", () => {
  it("reports `created` as Unix seconds, not as ISO", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const body = response.json() as { created?: unknown };

    // Spec D16: the native surface is ISO 8601 UTC, but this one follows the OpenAI
    // contract — clients compute `new Date(created * 1000)`, and a string here makes
    // that `Invalid Date`. The two formats are different contracts, not an oversight.
    expect(typeof body.created).toBe("number");
    expect(String(body.created)).not.toContain("-");
    const seconds = body.created as number;
    // A Unix timestamp in seconds for a plausible present-day instant: ten digits,
    // not the thirteen an ISO conversion or a milliseconds value would have.
    expect(seconds).toBeGreaterThan(1_700_000_000);
    expect(seconds).toBeLessThan(4_000_000_000);
  });

  it("reports `created` as Unix seconds on the streaming chunks too", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    // The streaming branch computes `created` on its own (`src/routes/chat.ts`),
    // separately from the non-stream body, so it needs the same pin: a `toIsoUtc`
    // applied only here would slip past the non-stream test and still break every
    // client that computes `new Date(created * 1000)`.
    const frame = response.body.split("\n\n").find((line) => line.startsWith("data: {"));
    const chunk = JSON.parse(frame!.slice("data: ".length)) as { created?: unknown };

    expect(typeof chunk.created).toBe("number");
    expect(String(chunk.created)).not.toContain("-");
    const seconds = chunk.created as number;
    expect(seconds).toBeGreaterThan(1_700_000_000);
    expect(seconds).toBeLessThan(4_000_000_000);
  });
});

describe("a model the upstream rejects", () => {
  it("names the model and the reason instead of blaming the pool", async () => {
    // The catalog must be applied, or the route's own guard answers 404 before the
    // upstream is ever called -- and the assertion below would pass for that reason.
    applyCatalog(CATALOG);
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Requested entity was not found."}}', { status: 404 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    seed();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: false, messages: [{ role: "user", content: "hi" }] },
    });
    const body = response.json() as { error: { message: string } };

    // The whole point of the fix: the message is the diagnosis. Before it read
    // "All accounts failed: ...(transient_rate_limit)", which sent the investigation to
    // the quota, where nothing was wrong (spec D12).
    expect(response.statusCode).toBe(404);
    expect(body.error.message).toContain("gemini-3.8-flash");
    expect(body.error.message).toContain("Requested entity was not found");
    expect(body.error.message).not.toContain("All accounts failed");
  });

  it("reports a pool drained by a quota wall as a non-retryable 400, not a 429 or 503", async () => {
    applyCatalog(CATALOG);
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Quota exceeded. Resets in 1h."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    seed();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: false, messages: [{ role: "user", content: "hi" }] },
    });
    const body = response.json() as { error: { type: string; message: string } };

    // Measured: a drained pool that answered 429 kept the client re-issuing every ~0.5s
    // while stuck in "thinking" -- a retryable status never ends the loop. A 400 the client
    // treats as final is what makes it give up and surface the message instead.
    expect(response.statusCode).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gemini-3.8-flash");
  });

  it("reports a pool drained by rate limits as a non-retryable 400", async () => {
    applyCatalog(CATALOG);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 4h46m21s."}}',
          { status: 429 },
        ),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    seed();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: false, messages: [{ role: "user", content: "hi" }] },
    });
    const body = response.json() as { error: { type: string; message: string } };

    expect(response.statusCode).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gemini-3.8-flash");
  });

  it("reports the terse 'no reset named' drain as a non-retryable 400 too", async () => {
    applyCatalog(CATALOG);
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}', { status: 429 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    seed();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: false, messages: [{ role: "user", content: "hi" }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("reports a rejected request as 400, not as a missing model", async () => {
    // Measured on the live backend: an advertised id (gemini-3-flash) answers 400
    // "Request contains an invalid argument" -- the model exists, the request is what
    // the backend refused. Mapping every definitive error onto 404 "not found" told the
    // caller the model was missing, sending the hunt to the catalog where nothing was
    // wrong.
    applyCatalog(CATALOG);
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":{"message":"Request contains an invalid argument."}}', { status: 400 }),
    ) as unknown as typeof fetch;
    app = buildServer("test-key", { store, env: ENV, fetchImpl, logger: false });
    seed();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: false, messages: [{ role: "user", content: "hi" }] },
    });
    const body = response.json() as { error: { message: string; type: string } };

    expect(response.statusCode).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("gemini-3.8-flash");
    expect(body.error.message).toContain("invalid argument");
  });
});

describe("a stream that dies mid-body", () => {
  /** Delivers one content chunk, then errors the body -- what a dropped connection does. */
  function diesAfterContent(): typeof fetch {
    return vi.fn(async () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"response":{"candidates":[{"content":{"parts":[{"text":"parcial"}]}}]}}\n\n',
              ),
            );
            return;
          }
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
  }

  it("closes the stream with an error frame and [DONE] instead of truncating silently", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: diesAfterContent(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    const body = response.body;
    // The content that did arrive is kept...
    expect(body).toContain("parcial");
    // ...and the break is announced rather than left as silence, so a client can tell a
    // failed turn from a finished one. Without the frame the client either waits forever
    // or reports a truncated answer as complete.
    expect(body).toContain('"error"');
    expect(body).toContain("data: [DONE]");
  });

  it("every frame in the body is parseable JSON or the DONE sentinel", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: diesAfterContent(), logger: false });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    });

    const frames = response.body
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length));

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      if (frame === "[DONE]") continue;
      // A broken frame would be worse than the original fault: the client would have no
      // way to read the error and no way to know the stream ended.
      expect(() => JSON.parse(frame), `frame: ${frame}`).not.toThrow();
    }
  });
});

/**
 * A Fastify logger that serializes to memory, so a test can read the structured
 * JSON an operator would grep in the terminal.
 */
function captureFastifyLog(): {
  logger: FastifyServerOptions["logger"];
  entries: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  return {
    logger: { level: "debug", stream: { write: (line: string) => void chunks.push(line) } },
    entries: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("request logging", () => {
  it("reports an oversized body as a 413 instead of a silent drop", async () => {
    const { logger, entries } = captureFastifyLog();
    app = buildServer("test-key", {
      store,
      env: { ...ENV, BODY_LIMIT_BYTES: "64" },
      fetchImpl: fetchOk(),
      logger,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "x".repeat(500) }] },
    });

    expect(response.statusCode).toBe(413);
    const line = entries().find((entry) => entry.msg === "request failed");
    expect(line?.status).toBe(413);
  });

  it("a default body limit above 1 MiB serves the large turns the old limit refused", async () => {
    const { logger } = captureFastifyLog();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "x".repeat(2_000_000) }] },
    });

    expect(response.statusCode).toBe(200);
  });

  it("logs the completed turn with its model, account and reqId", async () => {
    const { logger, entries } = captureFastifyLog();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "oi" }] },
    });

    const line = entries().find((entry) => entry.msg === "chat completed");
    expect(line?.model).toBe("gemini-3.8-flash");
    expect(line?.accountId).toBe("a1");
    expect(line?.finishReason).toBe("stop");
    expect(typeof line?.reqId).toBe("string");
  });

  it("streams usage chunk before [DONE] when stream_options.include_usage is true", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    expect(response.statusCode).toBe(200);
    const rawBlocks = response.body
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    expect(rawBlocks[rawBlocks.length - 1]).toBe("data: [DONE]");
    const usageFrameRaw = rawBlocks[rawBlocks.length - 2];
    expect(usageFrameRaw.startsWith("data: {")).toBe(true);
    const usageChunk = JSON.parse(usageFrameRaw.slice("data: ".length));
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toBeDefined();
    expect(usageChunk.usage.total_tokens).toBe(6);
  });

  it("forwards sampling options and stop sequences to envelope, adding standing warning for stop", async () => {
    const capture = fetchCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: capture.fetchImpl, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        stop: ["END_NOW"],
      },
    });

    expect(response.statusCode).toBe(200);
    const envelope = capture.envelope();
    const genConfig = (envelope?.request as any)?.generationConfig;
    expect(genConfig).toMatchObject({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      stopSequences: ["END_NOW"],
    });

    const json = response.json();
    expect(json.warnings).toBeDefined();
    expect(json.warnings).toContainEqual(
      expect.objectContaining({ field: "stop" }),
    );
  });

  it("omits empty stop array from envelope and does not add a warning", async () => {
    const capture = fetchCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: capture.fetchImpl, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        stop: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const envelope = capture.envelope();
    const genConfig = (envelope?.request as any)?.generationConfig;
    expect(genConfig?.stopSequences).toBeUndefined();
    expect(response.json().warnings).toBeUndefined();
  });

  it("forwards response_format json_schema to envelope generationConfig", async () => {
    const capture = fetchCapture();
    app = buildServer("test-key", { store, env: ENV, fetchImpl: capture.fetchImpl, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const envelope = capture.envelope();
    const genConfig = (envelope?.request as any)?.generationConfig;
    expect(genConfig?.responseMimeType).toBe("application/json");
    expect(genConfig?.responseSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(response.json().warnings).toContainEqual(
      expect.objectContaining({ field: "response_format.json_schema" }),
    );
  });

  it("collects warnings for declared-ignored, unrecognized body fields, and extra stream_options", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        seed: 42,
        presence_penalty: 1.5,
        future_unrecognized_opt: "xyz",
        stream_options: { other_flag: true },
      },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.warnings).toContainEqual(
      expect.objectContaining({ field: "seed" }),
    );
    expect(json.warnings).toContainEqual(
      expect.objectContaining({ field: "presence_penalty" }),
    );
    expect(json.warnings).toContainEqual(
      expect.objectContaining({ field: "future_unrecognized_opt" }),
    );
    expect(json.warnings).toContainEqual(
      expect.objectContaining({ field: "stream_options.other_flag" }),
    );
  });

  it("records diagnostic warning when stop parameter is malformed or invalid type", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const responseNumber = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        stop: 123,
      },
    });

    expect(responseNumber.statusCode).toBe(200);
    expect(responseNumber.json().warnings).toContainEqual(
      expect.objectContaining({
        field: "stop",
        reason: expect.stringMatching(/must be a string or array of strings/),
      }),
    );

    const responseNullArray = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        stop: [null],
      },
    });

    expect(responseNullArray.statusCode).toBe(200);
    expect(responseNullArray.json().warnings).toContainEqual(
      expect.objectContaining({
        field: "stop",
        reason: expect.stringMatching(/must be a string or array of strings/),
      }),
    );
  });

  it("emits explanatory warning when n parameter is provided", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        n: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().warnings).toContainEqual({
      field: "n",
      reason: "Field 'n' is not supported upstream and was ignored (only one choice is returned)",
    });
  });

  it("attaches warnings to stream finish-reason chunk and trailing usage chunk", async () => {
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "oi" }],
        stream: true,
        stream_options: { include_usage: true },
        seed: 1234,
      },
    });

    expect(response.statusCode).toBe(200);
    const rawBlocks = response.body
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    expect(rawBlocks[rawBlocks.length - 1]).toBe("data: [DONE]");

    // Trailing usage chunk
    const usageChunkRaw = rawBlocks[rawBlocks.length - 2];
    const usageChunk = JSON.parse(usageChunkRaw.slice("data: ".length));
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toBeDefined();
    expect(usageChunk.warnings).toContainEqual(
      expect.objectContaining({ field: "seed" }),
    );

    // Finish reason chunk immediately preceding usage chunk
    const finishChunkRaw = rawBlocks[rawBlocks.length - 3];
    const finishChunk = JSON.parse(finishChunkRaw.slice("data: ".length));
    expect(finishChunk.choices[0]?.finish_reason).toBe("stop");
    expect(finishChunk.warnings).toContainEqual(
      expect.objectContaining({ field: "seed" }),
    );
  });
});

