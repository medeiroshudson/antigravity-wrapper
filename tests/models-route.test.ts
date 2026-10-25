import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { AccountStore } from "../src/lib/accounts/store.js";
import { applyCatalog, resetRegistryForTests } from "../src/config/models.js";
import { CATALOG } from "./fixtures/catalog.js";

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
  resetRegistryForTests();
});

describe("GET /v1/models", () => {
  it("returns the list in the OpenAI format", async () => {
    applyCatalog(CATALOG);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe("list");
    expect(body.data.some((model) => model.id === "gemini-3.8-flash")).toBe(true);
  });

  it("advertises exactly the catalog's families, and nothing it cannot serve", async () => {
    applyCatalog(CATALOG);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const ids = (response.json() as { data: Array<{ id: string }> }).data.map((m) => m.id).sort();

    expect(ids).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
      "gpt-oss-120b",
    ]);
    // The static table advertised these three and the account had none of them.
    for (const phantom of ["gemini-3.1-pro", "gemini-3.6-flash", "gemini-3.7-flash"]) {
      expect(ids).not.toContain(phantom);
    }
  });

  it("carries the catalog's context window, output cap and label", async () => {
    applyCatalog(CATALOG);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const opus = (response.json() as {
      data: Array<Record<string, unknown>>;
    }).data.find((model) => model.id === "claude-opus-4-6");

    // Measured for this model: 250k in, 64k out, and the backend's own label with the
    // effort parenthesis stripped.
    expect(opus).toEqual({
      id: "claude-opus-4-6",
      object: "model",
      owned_by: "antigravity",
      name: "Claude Opus 4.6",
      normalized_name: "Claude Opus 4.6",
      display_name: "Claude Opus 4.6",
      context_length: 250_000,
      max_model_len: 250_000,
      max_output_tokens: 64_000,
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      reasoning: {
        supported_efforts: ["low", "medium", "high", "xhigh"],
      },
    });
  });

  it("advertises only model-specific reasoning efforts (e.g. gemini does not have xhigh)", async () => {
    applyCatalog(CATALOG);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const models = (response.json() as { data: Array<Record<string, any>> }).data;

    const flash = models.find((m) => m.id === "gemini-3.8-flash");
    expect(flash?.reasoning).toEqual({
      supported_efforts: ["low", "medium", "high"],
    });

    const pro = models.find((m) => m.id === "gemini-2.5-pro");
    expect(pro?.reasoning).toEqual({
      supported_efforts: ["low", "medium", "high"],
    });

    const sonnet = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet?.reasoning).toEqual({
      supported_efforts: ["low", "medium", "high"],
    });

    const gptOss = models.find((m) => m.id === "gpt-oss-120b");
    expect(gptOss?.reasoning).toEqual({
      supported_efforts: ["low", "medium", "high"],
    });
  });

  it("falls back to the public id for a label the backend did not supply", async () => {
    applyCatalog([{ id: "gemini-3.8-flash-tiered", displayName: "-", maxTokens: 100, maxOutputTokens: 50, supportsThinking: true, thinkingBudget: -1 }]);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const model = (response.json() as { data: Array<Record<string, unknown>> }).data[0];
    expect(model?.name).toBe("gemini-3.8-flash");
    expect(model?.normalized_name).toBe("gemini-3.8-flash");
    expect(model?.display_name).toBe("gemini-3.8-flash");
  });

  it("omits the numeric fields a partial entry did not supply", async () => {
    applyCatalog([{ id: "gemini-9.9-flash-low", displayName: "Gemini 9.9 Flash (Low)", maxTokens: null, maxOutputTokens: null, supportsThinking: false, thinkingBudget: null }]);
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    const model = (response.json() as { data: Array<Record<string, unknown>> }).data[0];
    expect(model).toEqual({
      id: "gemini-9.9-flash",
      object: "model",
      owned_by: "antigravity",
      name: "Gemini 9.9 Flash",
      normalized_name: "Gemini 9.9 Flash",
      display_name: "Gemini 9.9 Flash",
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    });
  });

  it("exposes gemini-3.1-flash-image image model with image output modality and no reasoning", async () => {
    applyCatalog([
      {
        id: "gemini-3.1-flash-image",
        displayName: "Gemini 3.1 Flash Image",
        maxTokens: null,
        maxOutputTokens: null,
        supportsThinking: false,
        thinkingBudget: null,
      },
    ]);
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<Record<string, unknown>> };
    const imgModel = body.data.find((m) => m.id === "gemini-3.1-flash-image");
    expect(imgModel).toBeDefined();
    expect(imgModel?.architecture).toEqual({
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
    });
    expect(imgModel?.reasoning).toBeUndefined();
  });

  it("returns an empty list when nothing has been discovered", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
    // No catalog means no models: advertising a static fallback is what produced the
    // unanswerable ids in the first place.
    expect((response.json() as { data: unknown[] }).data).toEqual([]);
  });
});

describe("GET /health", () => {
  it("responds ok with credentials", async () => {
    expect((await app.inject({ method: "GET", url: "/health", headers: auth })).statusCode).toBe(200);
  });
});

describe("the OpenAI surface keeps the OpenAI date contract", () => {
  // These model objects carry no date field at all; the assertion below needs a non-empty
  // list, and the registry has no static fallback, so the catalog is applied here.
  beforeEach(() => {
    applyCatalog(CATALOG);
  });

  it("does not introduce a date field on the model objects", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: auth,
    });
    const body = response.json() as { data: Array<Record<string, unknown>> };

    // Model objects carry no date at all today. If one is ever added it must follow
    // OpenAI's `created` (epoch seconds) rather than the native ISO rule (spec D16).
    // Fails closed: an empty list would make the loop below pass vacuously.
    expect(body.data.length).toBeGreaterThan(0);
    for (const model of body.data) {
      for (const [key, value] of Object.entries(model)) {
        const looksIso = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value);
        expect(looksIso, `${model.id}.${key} looks like an ISO date`).toBe(false);
      }
    }
  });
});
