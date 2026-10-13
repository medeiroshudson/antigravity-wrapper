import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";

let app: FastifyInstance;
let store: AccountStore;

beforeEach(() => {
  vi.stubEnv("API_KEY", undefined);
  store = new AccountStore(":memory:");
  app = buildServer("test-key", { store, logger: false });
});

afterEach(async () => {
  await app.close();
  store.close();
  vi.unstubAllEnvs();
});

describe("global authentication", () => {
  it("fails closed without API_KEY", () => {
    expect(() => buildServer("", { store })).toThrow("API_KEY must be configured");
    expect(() => buildServer(undefined, { store })).toThrow("API_KEY must be configured");
  });

  it.each([" leading", "comma,key"])("rejects an invalid key: %j", (key) => {
    expect(() => buildServer(key, { store })).toThrow("valid Bearer token");
  });

  it.each([
    ["missing", undefined],
    ["empty", "Bearer "],
    ["wrong", "Bearer nope"],
    ["basic", "Basic test-key"],
  ])("rejects %s before any route", async (_label, header) => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      ...(header ? { headers: { authorization: header } } : {}),
    });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["health", "GET", "/health"],
    ["models", "GET", "/v1/models"],
    ["accounts", "GET", "/admin/accounts"],
  ] as const)("requires Bearer on %s", async (_label, method, url) => {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
  });

  it("honors API_KEY from deps.env when the parameter is omitted", async () => {
    const scoped = buildServer(undefined, { store, env: { API_KEY: "env-key" }, logger: false });
    try {
      const ok = await scoped.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer env-key" },
      });
      expect(ok.statusCode).toBe(200);
      const wrong = await scoped.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer test-key" },
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await scoped.close();
    }
  });

  it("gives precedence to the parameter over deps.env.API_KEY", async () => {
    const scoped = buildServer("param-key", { store, env: { API_KEY: "env-key" }, logger: false });
    try {
      const ok = await scoped.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer param-key" },
      });
      expect(ok.statusCode).toBe(200);
      const wrong = await scoped.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: "Bearer env-key" },
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await scoped.close();
    }
  });
});
