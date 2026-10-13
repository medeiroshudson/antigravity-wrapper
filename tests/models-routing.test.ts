import { describe, expect, it } from "vitest";
import { getThinkingConfig, normalizeEffort, resolveRuntimeModel } from "../src/config/models.js";

describe("normalizeEffort", () => {
  it("accepts the known levels", () => {
    for (const value of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(normalizeEffort(value)).toBe(value);
    }
  });

  it("falls back to the default for an unknown value, without throwing", () => {
    expect(normalizeEffort("ultra")).toBe("off");
    expect(normalizeEffort(undefined)).toBe("off");
    expect(normalizeEffort(42)).toBe("off");
  });
});

describe("resolveRuntimeModel", () => {
  it("maps flash by level", () => {
    expect(resolveRuntimeModel("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low");
    expect(resolveRuntimeModel("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolveRuntimeModel("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
  });

  it("maps the off level to low", () => {
    expect(resolveRuntimeModel("gemini-3.8-flash", "off")).toBe("gemini-3.8-flash-low");
  });

  it("maps gemini-3.5-flash with the backend aliases", () => {
    expect(resolveRuntimeModel("gemini-3.5-flash", "low")).toBe("gemini-3.5-flash-extra-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "medium")).toBe("gemini-3.5-flash-low");
    expect(resolveRuntimeModel("gemini-3.5-flash", "high")).toBe("gemini-3-flash-agent");
  });

  it("maps gemini-3.1-pro to the agent at the high level", () => {
    expect(resolveRuntimeModel("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolveRuntimeModel("gemini-3.1-pro", "high")).toBe("gemini-pro-agent");
  });

  it("returns the id itself when there is no known routing", () => {
    expect(resolveRuntimeModel("gemini-9.9-flash", "high")).toBe("gemini-9.9-flash");
  });
});

describe("getThinkingConfig", () => {
  it("uses -1/4000/1000 on the 3.x flash family", () => {
    expect(getThinkingConfig("gemini-3.8-flash-low", "off")).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    });
    expect(getThinkingConfig("gemini-3.8-flash-high", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    });
    expect(getThinkingConfig("gemini-3.8-flash-medium", "medium")).toEqual({
      includeThoughts: true,
      thinkingBudget: 4000,
    });
  });

  it("uses 10000 at the high level of 3.5 flash", () => {
    expect(getThinkingConfig("gemini-3-flash-agent", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 10_000,
    });
  });

  it("uses 10001 at the high level of 3.1 pro", () => {
    expect(getThinkingConfig("gemini-pro-agent", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 10_001,
    });
  });

  it("uses 1024 for Claude and 8192 for GPT-OSS", () => {
    expect(getThinkingConfig("claude-opus-4-6-thinking", "high")).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    });
    expect(getThinkingConfig("gpt-oss-120b-medium", "medium")).toEqual({
      includeThoughts: true,
      thinkingBudget: 8192,
    });
  });
});
