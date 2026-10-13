import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { resetDiscoveredModelsForTests } from "../src/config/models.js";

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
  seed();
});

afterEach(async () => {
  await app.close();
  store.close();
  resetDiscoveredModelsForTests();
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
  });

  it("returns 503 when the pool is empty", async () => {
    store.removeAccount("a1");
    app = buildServer("test-key", { store, env: ENV, fetchImpl: fetchOk(), logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gemini-3.8-flash", messages: [{ role: "user", content: "oi" }] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toMatch(/no eligible account/i);
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
    const catalog = { models: { "claude-opus-4-6": { quotaInfo: { remainingFraction: 1 } } } };
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
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("gemini-3.8-flash");

    // Before the refresh, a public Claude id would 404; now the route accepts it.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "claude-opus-4-6", messages: [{ role: "user", content: "oi" }] },
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
});
