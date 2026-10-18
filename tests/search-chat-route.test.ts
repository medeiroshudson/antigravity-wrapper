import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { applyCatalog, resetRegistryForTests } from "../src/config/models.js";
import { CATALOG } from "./fixtures/catalog.js";

describe("POST /v1/chat/completions with web_search", () => {
  let store: AccountStore;

  beforeEach(() => {
    store = new AccountStore(":memory:");
    store.upsertAccount({
      id: "acc-1",
      email: "test@example.com",
      refreshToken: "r",
      accessToken: "tok",
      accessExpiresAt: Date.now() + 3_600_000,
      projectId: "aicode-consumers",
    });
    applyCatalog(CATALOG);
  });

  afterEach(() => {
    store.close();
    resetRegistryForTests();
  });

  it("accepts web_search: true and injects googleSearch into upstream request", async () => {
    let capturedBody: any;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"response":{"candidates":[{"content":{"parts":[{"text":"Result"}]}}]}}\n\n`,
              ),
            );
            controller.close();
          },
        }),
      };
    };

    const server = buildServer("test-key", { store, fetchImpl: mockFetch as any, logger: false });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "gemini-3.5-flash-lite",
        messages: [{ role: "user", content: "Noticias de hoje" }],
        web_search: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnings?.some((w: any) => w.field === "web_search")).toBeFalsy();
    expect(capturedBody.request.tools).toBeDefined();
    expect(capturedBody.request.tools).toContainEqual({ googleSearch: {} });
  });

  it("warns when web_search is requested on Claude models and does not inject googleSearch", async () => {
    let capturedBody: any;
    const mockFetch = async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"response":{"candidates":[{"content":{"parts":[{"text":"Claude response"}]}}]}}\n\n`,
              ),
            );
            controller.close();
          },
        }),
      };
    };

    const server = buildServer("test-key", { store, fetchImpl: mockFetch as any, logger: false });
    const res = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hello" }],
        web_search: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.warnings).toBeDefined();
    expect(body.warnings.some((w: any) => w.field === "web_search" && w.reason.includes("Gemini"))).toBe(true);
    expect(capturedBody.request.tools).toBeUndefined();
  });
});
