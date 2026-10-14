import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { resetDiscoveredModelsForTests } from "../src/config/models.js";

let app: FastifyInstance;
let store: AccountStore;
const auth = { authorization: "Bearer test-key" };

beforeEach(() => {
  store = new AccountStore(":memory:");
  app = buildServer("test-key", { store, logger: false });
});

afterEach(async () => {
  await app.close();
  store.close();
  resetDiscoveredModelsForTests();
});

describe("GET /v1/models", () => {
  it("returns the list in the OpenAI format", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe("list");
    expect(body.data.some((m) => m.id === "gemini-3.8-flash")).toBe(true);
  });
});

describe("GET /health", () => {
  it("responds ok with credentials", async () => {
    expect((await app.inject({ method: "GET", url: "/health", headers: auth })).statusCode).toBe(200);
  });
});

describe("the OpenAI surface keeps the OpenAI date contract", () => {
  it("does not introduce a date field on the model objects", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: auth,
    });
    const body = response.json() as { data: Array<Record<string, unknown>> };

    // Model objects carry no date at all today. If one is ever added it must follow
    // OpenAI's `created` (epoch seconds) rather than the native ISO rule (spec D16).
    for (const model of body.data) {
      for (const [key, value] of Object.entries(model)) {
        const looksIso = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value);
        expect(looksIso, `${model.id}.${key} looks like an ISO date`).toBe(false);
      }
    }
  });
});
