// tests/stream-usage.test.ts
import { describe, expect, it } from "vitest";
import { buildChunk } from "../src/lib/openai-format/index.js";

describe("buildChunk with usage and warnings", () => {
  it("builds a final usage chunk with choices: [] and usage payload", () => {
    const chunk = buildChunk({
      id: "chatcmpl-1",
      created: 1700000000,
      model: "gemini-2.5-flash",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      warnings: [{ field: "seed", reason: "ignored" }],
    });

    expect(chunk.choices).toEqual([]);
    expect(chunk.usage).toMatchObject({ prompt_tokens: 10, total_tokens: 30 });
    expect((chunk as any).warnings).toEqual([{ field: "seed", reason: "ignored" }]);
  });

  it("omits usage and warnings when not provided in options object", () => {
    const chunk = buildChunk({
      id: "chatcmpl-2",
      created: 1700000000,
      model: "gemini-2.5-flash",
      delta: { content: "hello" },
      finishReason: null,
    });

    expect(chunk.id).toBe("chatcmpl-2");
    expect(chunk.choices).toEqual([{ index: 0, delta: { content: "hello" }, finish_reason: null }]);
    expect(chunk.usage).toBeUndefined();
    expect(chunk.warnings).toBeUndefined();
  });

  it("omits warnings when warnings array is empty", () => {
    const chunk = buildChunk({
      id: "chatcmpl-3",
      model: "gemini-2.5-flash",
      created: 1700000000,
      choices: [],
      warnings: [],
    });

    expect(chunk.choices).toEqual([]);
    expect(chunk.warnings).toBeUndefined();
  });
});
