import { afterEach, describe, expect, it } from "vitest";
import {
  applyCatalog,
  getMaxOutputTokens,
  getPublicModels,
  getThinkingConfig,
  normalizeEffort,
  resetRegistryForTests,
  resolveRuntimeModel,
  type ReasoningEffort,
} from "../src/config/models.js";
import { CATALOG } from "./fixtures/catalog.js";

const EFFORTS: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

afterEach(() => {
  resetRegistryForTests();
});

describe("normalizeEffort", () => {
  it("accepts the known levels", () => {
    for (const value of EFFORTS) expect(normalizeEffort(value)).toBe(value);
  });

  it("falls back to off for an unknown value, without throwing", () => {
    expect(normalizeEffort("ultra")).toBe("off");
    expect(normalizeEffort(undefined)).toBe("off");
    expect(normalizeEffort(42)).toBe("off");
  });
});

describe("the registry", () => {
  it("advertises one model per family, with the variant list of each", () => {
    applyCatalog(CATALOG);
    const ids = getPublicModels().map((model) => model.id).sort();
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
  });

  it("keeps -lite as identity, so the five Flash-Lite aliases stay four models", () => {
    applyCatalog(CATALOG);
    // The backend gives all five ids the same display label, and their ids differ, so the
    // label must not be the key (spec §3.5).
    for (const id of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]) {
      expect(getPublicModels().map((model) => model.id)).toContain(id);
    }
  });

  it("treats an effort suffix as a variant, never as a model", () => {
    applyCatalog(CATALOG);
    const ids = getPublicModels().map((model) => model.id);
    for (const absent of [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-tiered",
      "gemini-3-flash-agent",
      "claude-opus-4-6-thinking",
    ]) {
      expect(ids).not.toContain(absent);
    }
    const flash = getPublicModels().find((model) => model.id === "gemini-3.8-flash");
    expect(flash?.variants.map((v) => v.runtimeId).sort()).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-tiered",
    ]);
  });

  it("advertises no phantom model, because the catalog is the only source", () => {
    applyCatalog(CATALOG);
    const ids = getPublicModels().map((model) => model.id);
    for (const phantom of ["gemini-3.1-pro", "gemini-3.6-flash", "gemini-3.7-flash"]) {
      expect(ids).not.toContain(phantom);
    }
  });

  it("takes the context window and output cap from the catalog", () => {
    applyCatalog(CATALOG);
    const opus = getPublicModels().find((model) => model.id === "claude-opus-4-6");
    // The static table had no entry for this model at all; the catalog does.
    expect(opus?.contextWindow).toBe(250_000);
    expect(opus?.maxTokens).toBe(64_000);
    expect(getMaxOutputTokens("claude-opus-4-6-thinking")).toBe(64_000);
  });

  it("labels a model from the backend, with the effort parenthesis removed", () => {
    applyCatalog(CATALOG);
    const flash = getPublicModels().find((model) => model.id === "gemini-3.8-flash");
    expect(flash?.label).toBe("Gemini 3.8 Flash");
    const opus = getPublicModels().find((model) => model.id === "claude-opus-4-6");
    expect(opus?.label).toBe("Claude Opus 4.6");
  });

  it("falls back to the public id when no variant carries a real label", () => {
    applyCatalog([{ id: "gemini-3.8-flash-tiered", displayName: "-", maxTokens: 100, maxOutputTokens: 50, supportsThinking: true, thinkingBudget: -1 }]);
    expect(getPublicModels()[0]?.label).toBe("gemini-3.8-flash");
  });

  it("survives a catalog entry with missing numbers", () => {
    // A partial entry must still be advertised and resolvable: dropping it would hide a
    // model the account can serve, and throwing would lose the whole refresh.
    applyCatalog([{ id: "gemini-9.9-flash-low", displayName: "Gemini 9.9 Flash (Low)", maxTokens: null, maxOutputTokens: null, supportsThinking: false, thinkingBudget: null }]);
    expect(getPublicModels().map((model) => model.id)).toEqual(["gemini-9.9-flash"]);
    expect(getPublicModels()[0]?.contextWindow).toBe(0);
    expect(getMaxOutputTokens("gemini-9.9-flash-low")).toBe(64_000);
  });

  it("unions across refreshes, so a model only one account offers survives", () => {
    applyCatalog(CATALOG);
    applyCatalog([{ id: "gpt-5-medium", displayName: "GPT-5 (Medium)", maxTokens: 1000, maxOutputTokens: 100, supportsThinking: false, thinkingBudget: null }]);
    const ids = getPublicModels().map((model) => model.id);
    expect(ids).toContain("gpt-5");
    // The first catalog is still there: the registry accumulates.
    expect(ids).toContain("claude-opus-4-6");
  });

  it("ignores ids outside the families, the internals and the image models", () => {
    applyCatalog([
      { id: "chat_20706", displayName: "-", maxTokens: 1, maxOutputTokens: 1, supportsThinking: false, thinkingBudget: null },
      { id: "tab_flash_lite_preview", displayName: "-", maxTokens: 1, maxOutputTokens: 1, supportsThinking: false, thinkingBudget: null },
      { id: "gemini-3.1-flash-image", displayName: "Gemini 3.1 Flash Image", maxTokens: 1, maxOutputTokens: 1, supportsThinking: false, thinkingBudget: null },
      { id: "llama-4-scout", displayName: "Llama 4 Scout", maxTokens: 1, maxOutputTokens: 1, supportsThinking: false, thinkingBudget: null },
    ]);
    expect(getPublicModels()).toEqual([]);
  });
});

describe("resolveRuntimeModel", () => {
  it("resolves a single-variant group at every effort", () => {
    applyCatalog(CATALOG);
    // The reported bug: the only Opus in the catalog is `-thinking`, so every effort must
    // reach it. Sending the stripped id returned 404 (spec §3.2).
    for (const effort of EFFORTS) {
      expect(resolveRuntimeModel("claude-opus-4-6", effort)).toBe("claude-opus-4-6-thinking");
    }
    for (const effort of EFFORTS) {
      expect(resolveRuntimeModel("claude-sonnet-4-6", effort)).toBe("claude-sonnet-4-6");
    }
  });

  it("picks the nearest degree for a multi-variant group", () => {
    applyCatalog(CATALOG);
    expect(resolveRuntimeModel("gemini-3.8-flash", "off")).toBe("gemini-3.8-flash-low");
    expect(resolveRuntimeModel("gemini-3.8-flash", "minimal")).toBe("gemini-3.8-flash-low");
    expect(resolveRuntimeModel("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolveRuntimeModel("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
  });

  it("never resolves above what was asked when the degree ties", () => {
    applyCatalog(CATALOG);
    // `-high` and `-tiered` are both degree 4. `xhigh` asks for the top and gets the
    // lexicographically first of the equals, which is not a promotion beyond the request.
    expect(resolveRuntimeModel("gemini-3.8-flash", "xhigh")).toBe("gemini-3.8-flash-high");
    // `-high` matches the effort name, so it wins over the other degree-4 variant.
    expect(resolveRuntimeModel("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
  });

  it("resolves a two-variant group at both ends", () => {
    applyCatalog(CATALOG);
    expect(resolveRuntimeModel("gemini-3.5-flash", "low")).toBe("gemini-3.5-flash-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "high")).toBe("gemini-3.5-flash-low");
    expect(resolveRuntimeModel("gemini-2.5-flash", "high")).toBe("gemini-2.5-flash-thinking");
    expect(resolveRuntimeModel("gemini-3-flash", "high")).toBe("gemini-3-flash-agent");
  });

  it("reaches the lowest variant only through off and minimal", () => {
    applyCatalog(CATALOG);
    // For a group whose variants sit at degrees 0 and 1, nearest-with-tie-down sends every
    // effort from `low` up to the degree-1 variant; only "the lowest available" selects
    // degree 0. Pinning it keeps that from reading as an accident later.
    expect(resolveRuntimeModel("gemini-3.5-flash", "off")).toBe("gemini-3.5-flash-extra-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "minimal")).toBe("gemini-3.5-flash-extra-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "medium")).toBe("gemini-3.5-flash-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "xhigh")).toBe("gemini-3.5-flash-low");
  });

  it("returns the id itself when the registry does not know it", () => {
    applyCatalog(CATALOG);
    expect(resolveRuntimeModel("gemini-9.9-flash", "high")).toBe("gemini-9.9-flash");
  });

  it("is deterministic: one public id plus one effort yields one runtime id", () => {
    applyCatalog(CATALOG);
    for (const model of getPublicModels()) {
      for (const effort of EFFORTS) {
        expect(resolveRuntimeModel(model.id, effort)).toBe(resolveRuntimeModel(model.id, effort));
      }
    }
  });

  it("only ever resolves to a runtime id the catalog listed", () => {
    applyCatalog(CATALOG);
    const listed = new Set(CATALOG.map((entry) => entry.id));
    // The reachability invariant: nothing advertised can resolve to an id the backend
    // does not have. This is the test that would have caught the reported bug.
    for (const model of getPublicModels()) {
      for (const effort of EFFORTS) {
        expect(listed.has(resolveRuntimeModel(model.id, effort))).toBe(true);
      }
    }
  });
});

describe("getThinkingConfig", () => {
  it("forces thinking off when the effort is off, whatever the catalog says", () => {
    applyCatalog(CATALOG);
    for (const runtimeId of ["gemini-3.8-flash-high", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]) {
      expect(getThinkingConfig(runtimeId, "off")).toEqual({ includeThoughts: false, thinkingBudget: 0 });
    }
  });

  it("uses the catalog's budget for the model", () => {
    applyCatalog(CATALOG);
    expect(getThinkingConfig("gemini-3.8-flash-high", "high")).toEqual({ includeThoughts: true, thinkingBudget: -1 });
    expect(getThinkingConfig("gemini-3.8-flash-medium", "medium")).toEqual({ includeThoughts: true, thinkingBudget: 4000 });
    expect(getThinkingConfig("gemini-3.8-flash-low", "low")).toEqual({ includeThoughts: true, thinkingBudget: 1000 });
    expect(getThinkingConfig("claude-opus-4-6-thinking", "high")).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
    expect(getThinkingConfig("gpt-oss-120b-medium", "medium")).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
  });

  it("reports no thinking for a model the catalog says cannot think", () => {
    applyCatalog([{ id: "gemini-9.9-flash-low", displayName: null, maxTokens: 100, maxOutputTokens: 50, supportsThinking: false, thinkingBudget: null }]);
    expect(getThinkingConfig("gemini-9.9-flash-low", "high")).toEqual({ includeThoughts: false, thinkingBudget: 0 });
  });

  it("reports no thinking for an unknown runtime id rather than throwing", () => {
    applyCatalog(CATALOG);
    expect(getThinkingConfig("nao-existe", "high")).toEqual({ includeThoughts: false, thinkingBudget: 0 });
  });
});

describe("getMaxOutputTokens", () => {
  it("reads the catalog and falls back when the id is unknown", () => {
    applyCatalog(CATALOG);
    expect(getMaxOutputTokens("gpt-oss-120b-medium")).toBe(32_768);
    expect(getMaxOutputTokens("gemini-2.5-pro")).toBe(65_535);
    expect(getMaxOutputTokens("nao-existe")).toBe(64_000);
  });
});
