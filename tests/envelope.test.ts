import { describe, expect, it } from "vitest";
import { buildEnvelope, newRequestIdentity } from "../src/lib/antigravity/envelope.js";

describe("newRequestIdentity", () => {
  it("builds the requestId in the agent/<conv>/<ts>/<traj>/<step> format", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low");
    expect(id.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/);
  });

  it("includes the fingerprint labels, without last_execution_id on the first step", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low");
    expect(Object.keys(id.labels).sort()).toEqual([
      "last_step_index",
      "request_id",
      "trajectory_id",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
    ]);
    expect(id.labels.last_step_index).toBe("0");
  });

  it("adds last_execution_id from the second step on", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low", { step: 2, requestIndex: 1 });
    expect(id.labels.last_execution_id).toBeDefined();
    expect(id.labels.last_step_index).toBe("1");
    expect(id.labels.request_id).toBe(`${id.trajectoryId}-1`);
  });

  it("marks used_claude for Claude models", () => {
    const id = newRequestIdentity("claude-sonnet-4-6");
    expect(id.labels.used_claude).toBe("true");
    expect(id.labels.used_non_gemini_model).toBe("true");
  });

  it("generates sessionId as a 64-bit integer in string form", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low");
    expect(id.sessionId).toMatch(/^-?\d+$/);
    expect(BigInt(id.sessionId)).toBeLessThan(2n ** 63n);
  });
});

describe("buildEnvelope", () => {
  const base = {
    projectId: "aicode-consumers",
    runtimeModel: "gemini-3.8-flash-low",
    contents: [{ role: "user" as const, parts: [{ text: "oi" }] }],
    systemInstruction: "Voce e um assistente.",
    thinking: { includeThoughts: false, thinkingBudget: 0 },
    maxOutputTokens: 64,
    sessionId: "123",
    labels: { trajectory_id: "t" },
    requestId: "agent/c/1/t/1",
  };

  it("builds the envelope with the required top-level fields", () => {
    const out = buildEnvelope(base);
    expect(out.project).toBe("aicode-consumers");
    expect(out.model).toBe("gemini-3.8-flash-low");
    expect(out.requestType).toBe("agent");
    expect(out.userAgent).toBe("antigravity");
    expect(out.requestId).toBe("agent/c/1/t/1");
  });

  it("puts thinkingConfig and maxOutputTokens in generationConfig", () => {
    const out = buildEnvelope({ ...base, thinking: { includeThoughts: true, thinkingBudget: -1 } });
    expect(out.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
    });
    expect(out.request.generationConfig?.maxOutputTokens).toBe(64);
  });

  it("puts labels and sessionId inside request", () => {
    const out = buildEnvelope(base);
    expect(out.request.labels).toEqual({ trajectory_id: "t" });
    expect(out.request.sessionId).toBe("123");
  });

  it("includes tools only when provided", () => {
    expect(buildEnvelope(base).request.tools).toBeUndefined();
    expect(buildEnvelope({ ...base, tools: [{ functionDeclarations: [{ name: "x" }] }] }).request.tools).toHaveLength(1);
  });

  it("sends systemInstruction with role user", () => {
    expect(buildEnvelope(base).request.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "Voce e um assistente." }],
    });
  });
});
