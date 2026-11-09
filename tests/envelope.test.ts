import { describe, expect, it } from "vitest";
import { buildEnvelope, newRequestIdentity } from "../src/lib/antigravity/envelope.js";

function conversation(step = 1, requestIndex = 0, lastExecutionId: string | null = null) {
  return { cascadeId: "cascade-1", trajectoryId: "traj-1", sessionId: "-42", step, requestIndex, lastExecutionId };
}

describe("newRequestIdentity", () => {
  it("builds the requestId from the conversation, in the measured format", () => {
    // Captured 2026-11-09: agent/<cascade_id>/<epoch_ms>/<trajectory_id>/<step>
    const id = newRequestIdentity("gemini-3.8-flash-low", conversation());
    expect(id.requestId).toMatch(/^agent\/cascade-1\/\d+\/traj-1\/1$/);
  });

  it("carries the conversation labels the client sends", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low", conversation(), "MODEL_PLACEHOLDER_M320");
    expect(id.labels).toMatchObject({
      cascade_id: "cascade-1",
      root_cascade_id: "cascade-1",
      trajectory_id: "traj-1",
      request_id: "traj-1-0",
      last_step_index: "0",
      model_enum: "MODEL_PLACEHOLDER_M320",
    });
    expect(id.labels.last_execution_id).toBeUndefined();
  });

  it("keeps the cascade and the session across steps and only moves the step", () => {
    // Measured over two turns: step 0 -> 1 while request_id went 0 -> 1, and the second
    // request names the previous execution with a UUID.
    const first = newRequestIdentity("gemini-3.8-flash-low", conversation(1, 0, null));
    const second = newRequestIdentity("gemini-3.8-flash-low", conversation(2, 1, "exec-uuid"));
    expect(second.cascadeId).toBe(first.cascadeId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.labels.last_step_index).toBe("1");
    expect(second.labels.request_id).toBe("traj-1-1");
    expect(second.labels.last_execution_id).toBe("exec-uuid");
    expect(first.labels.last_execution_id).toBeUndefined();
  });

  it("keeps request_id on its own counter when the step advances by more than one", () => {
    // The client's steps are agent steps, not turns: its second request carried
    // last_step_index 3 while request_id stayed at -1.
    const id = newRequestIdentity("gemini-3.8-flash-low", conversation(4, 1, "exec-uuid"));
    expect(id.labels.last_step_index).toBe("3");
    expect(id.labels.request_id).toBe("traj-1-1");
    expect(id.requestId).toMatch(/\/4$/);
  });

  it("omits model_enum when the catalog did not provide one", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low", conversation(), null);
    expect(id.labels.model_enum).toBeUndefined();
  });

  it("marks used_claude for Claude models", () => {
    const id = newRequestIdentity("claude-sonnet-4-6", conversation());
    expect(id.labels.used_claude).toBe("true");
    expect(id.labels.used_non_gemini_model).toBe("true");
  });

  it("keeps the conversation's sessionId, which is a signed 64-bit integer", () => {
    const id = newRequestIdentity("gemini-3.8-flash-low", conversation());
    expect(id.sessionId).toBe("-42");
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

  it("sends the thinking level the client sends, without a budget", () => {
    // Captured 2026-11-09: {"includeThoughts": true, "thinkingLevel": "HIGH"}.
    const out = buildEnvelope({ ...base, thinking: { includeThoughts: true, thinkingLevel: "HIGH" } });
    expect(out.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(out.request.generationConfig?.thinkingConfig).not.toHaveProperty("thinkingBudget");
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
