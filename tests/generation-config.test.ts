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
