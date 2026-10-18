import { describe, expect, it } from "vitest";
import { buildEnvelope, type EnvelopeInput } from "../src/lib/antigravity/envelope.js";

describe("search tool injection in envelope", () => {
  const baseInput: EnvelopeInput = {
    projectId: "aicode-consumers",
    runtimeModel: "gemini-3.8-flash-low",
    contents: [{ role: "user", parts: [{ text: "Quem venceu as eleicoes?" }] }],
    systemInstruction: "You are a helpful assistant.",
    thinking: { includeThoughts: false, thinkingBudget: 0 },
    maxOutputTokens: 1024,
    sessionId: "12345",
    labels: {},
    requestId: "req-1",
  };

  it("injects googleSearch tool when enableWebSearch is true on Gemini model", () => {
    const envelope = buildEnvelope({ ...baseInput, enableWebSearch: true });
    expect(envelope.request.tools).toBeDefined();
    expect(envelope.request.tools).toContainEqual({ googleSearch: {} });
  });

  it("combines googleSearch and custom function declarations", () => {
    const customTool = { functionDeclarations: [{ name: "my_func", description: "desc" }] };
    const envelope = buildEnvelope({
      ...baseInput,
      enableWebSearch: true,
      tools: [customTool],
    });
    expect(envelope.request.tools).toHaveLength(2);
    expect(envelope.request.tools![0]).toEqual({ googleSearch: {} });
    expect(envelope.request.tools![1]).toEqual(customTool);
  });

  it("does not inject googleSearch when enableWebSearch is false or undefined", () => {
    const envelopeFalse = buildEnvelope({ ...baseInput, enableWebSearch: false });
    expect(envelopeFalse.request.tools).toBeUndefined();

    const envelopeUndefined = buildEnvelope({ ...baseInput, enableWebSearch: undefined });
    expect(envelopeUndefined.request.tools).toBeUndefined();
  });

  it("does not inject googleSearch on Claude or GPT-OSS models", () => {
    const claudeEnvelope = buildEnvelope({
      ...baseInput,
      runtimeModel: "claude-sonnet-4-6",
      enableWebSearch: true,
    });
    expect(claudeEnvelope.request.tools).toBeUndefined();

    const gptEnvelope = buildEnvelope({
      ...baseInput,
      runtimeModel: "gpt-oss-1",
      enableWebSearch: true,
    });
    expect(gptEnvelope.request.tools).toBeUndefined();
  });
});
