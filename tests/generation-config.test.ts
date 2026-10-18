import { describe, expect, it } from "vitest";
import { buildEnvelope, newRequestIdentity } from "../src/lib/antigravity/envelope.js";
import { isGenerationConfigMapEnabled } from "../src/config/index.js";

describe("buildEnvelope generationConfig mapping", () => {
  it("maps temperature, topP, topK, and stopSequences into generationConfig", () => {
    const identity = newRequestIdentity("gemini-2.5-flash");
    const envelope = buildEnvelope({
      projectId: "proj-1",
      runtimeModel: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: "sys",
      thinking: { includeThoughts: false, thinkingBudget: 0 },
      maxOutputTokens: 2048,
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      stopSequences: ["END", "STOP"],
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
    });

    expect(envelope.request.generationConfig).toMatchObject({
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      stopSequences: ["END", "STOP"],
    });
  });

  it("omits empty stopSequences array from generationConfig", () => {
    const identity = newRequestIdentity("gemini-2.5-flash");
    const envelope = buildEnvelope({
      projectId: "proj-1",
      runtimeModel: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: "sys",
      thinking: { includeThoughts: false, thinkingBudget: 0 },
      maxOutputTokens: 2048,
      stopSequences: [],
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
    });

    expect(envelope.request.generationConfig?.stopSequences).toBeUndefined();
  });

  it("maps responseMimeType and responseSchema into generationConfig", () => {
    const identity = newRequestIdentity("gemini-2.5-flash");
    const schema = { type: "object", properties: { key: { type: "string" } } };
    const envelope = buildEnvelope({
      projectId: "proj-1",
      runtimeModel: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: "sys",
      thinking: { includeThoughts: false, thinkingBudget: 0 },
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: schema,
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
    });

    expect(envelope.request.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseSchema: schema,
    });
  });
});

describe("isGenerationConfigMapEnabled", () => {
  it("defaults to true when GENERATION_CONFIG_MAP is unset", () => {
    expect(isGenerationConfigMapEnabled({})).toBe(true);
  });

  it("returns false when GENERATION_CONFIG_MAP is 'off'", () => {
    expect(isGenerationConfigMapEnabled({ GENERATION_CONFIG_MAP: "off" })).toBe(false);
  });

  it("returns true when GENERATION_CONFIG_MAP is any other value", () => {
    expect(isGenerationConfigMapEnabled({ GENERATION_CONFIG_MAP: "on" })).toBe(true);
    expect(isGenerationConfigMapEnabled({ GENERATION_CONFIG_MAP: "true" })).toBe(true);
  });
});

describe("max_tokens and max_completion_tokens aliasing", () => {
  it("rejects conflicting max_tokens and max_completion_tokens with HTTP 400", async () => {
    const { AccountStore } = await import("../src/lib/accounts/store.js");
    const { applyCatalog, resetRegistryForTests } = await import("../src/config/models.js");
    const { CATALOG } = await import("./fixtures/catalog.js");
    const { buildServer } = await import("../src/server.js");

    const store = new AccountStore(":memory:");
    applyCatalog(CATALOG);
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "tok",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });
    const app = buildServer("secret", {
      store,
      env: { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" },
      logger: false,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 100,
          max_completion_tokens: 200,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/conflicting/i);
    } finally {
      await app.close();
      store.close();
      resetRegistryForTests();
    }
  });

  it("accepts max_completion_tokens alone and forwards it as maxOutputTokens", async () => {
    const { AccountStore } = await import("../src/lib/accounts/store.js");
    const { applyCatalog, resetRegistryForTests } = await import("../src/config/models.js");
    const { CATALOG } = await import("./fixtures/catalog.js");
    const { buildServer } = await import("../src/server.js");

    const store = new AccountStore(":memory:");
    applyCatalog(CATALOG);
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "tok",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });

    let capturedBody: any = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      const sse = [
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const app = buildServer("secret", {
      store,
      fetchImpl,
      env: { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" },
      logger: false,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hi" }],
          max_completion_tokens: 350,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(capturedBody?.request?.generationConfig?.maxOutputTokens).toBe(350);
    } finally {
      await app.close();
      store.close();
      resetRegistryForTests();
    }
  });

  it("accepts matching max_tokens and max_completion_tokens", async () => {
    const { AccountStore } = await import("../src/lib/accounts/store.js");
    const { applyCatalog, resetRegistryForTests } = await import("../src/config/models.js");
    const { CATALOG } = await import("./fixtures/catalog.js");
    const { buildServer } = await import("../src/server.js");

    const store = new AccountStore(":memory:");
    applyCatalog(CATALOG);
    store.upsertAccount({
      id: "a1",
      email: "a1@x.com",
      refreshToken: "r",
      accessToken: "tok",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });

    let capturedBody: any = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      const sse = [
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const app = buildServer("secret", {
      store,
      fetchImpl,
      env: { ANTIGRAVITY_CLIENT_ID: "c", ANTIGRAVITY_CLIENT_SECRET: "s" },
      logger: false,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 250,
          max_completion_tokens: 250,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(capturedBody?.request?.generationConfig?.maxOutputTokens).toBe(250);
    } finally {
      await app.close();
      store.close();
      resetRegistryForTests();
    }
  });
});

