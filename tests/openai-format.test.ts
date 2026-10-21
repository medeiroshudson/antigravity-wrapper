import { describe, expect, it } from "vitest";
import {
  buildChunk,
  buildCompletion,
  sseEvent,
  SSE_DONE,
  toOpenAIErrorBody,
  type TurnResult,
} from "../src/lib/openai-format/index.js";

describe("buildCompletion", () => {
  it("builds the choice with content and usage", () => {
    const out = buildCompletion(
      {
        content: "ola",
        finishReason: "stop",
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        toolCalls: [],
      },
      "gemini-3.8-flash",
    );
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0]?.message.content).toBe("ola");
    expect(out.usage?.total_tokens).toBe(4);
  });

  it("includes reasoning_content in completion message when present", () => {
    const result: TurnResult = {
      content: "Final answer",
      reasoningContent: "Thinking step by step...",
      finishReason: "stop",
      usage: null,
      toolCalls: [],
    };
    const completion = buildCompletion(result, "gemini-3.8-flash");
    expect(completion.choices[0]?.message.reasoning_content).toBe("Thinking step by step...");
    expect(completion.choices[0]?.message.content).toBe("Final answer");
  });

  it("supports reasoning_content alongside tool_calls in completion", () => {
    const result: TurnResult = {
      content: "",
      reasoningContent: "I need to call get_weather",
      finishReason: "tool_calls",
      usage: null,
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    };
    const completion = buildCompletion(result, "gemini-3.8-flash");
    expect(completion.choices[0]?.message.reasoning_content).toBe("I need to call get_weather");
    expect(completion.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(completion.choices[0]?.message.content).toBeNull();
  });

  it("attaches grounding_metadata when groundingMetadata is present", () => {
    const out = buildCompletion(
      {
        content: "ola",
        finishReason: "stop",
        usage: null,
        toolCalls: [],
        groundingMetadata: {
          webSearchQueries: ["query 1"],
          groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
        },
      },
      "gemini-3.8-flash",
    );
    expect(out.choices[0]?.message.grounding_metadata).toEqual({
      webSearchQueries: ["query 1"],
      sources: [{ title: "Example", url: "https://example.com" }],
    });
  });

  it("nulls the content and fills tool_calls when there are calls", () => {
    const out = buildCompletion(
      {
        content: "",
        finishReason: "tool_calls",
        usage: null,
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
      },
      "gemini-3.8-flash",
    );
    expect(out.choices[0]?.message.content).toBeNull();
    expect(out.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("get_weather");
  });

  it("emits thoughtSignature only when present (identical response without the signature)", () => {
    const without = buildCompletion(
      {
        content: "",
        finishReason: "tool_calls",
        usage: null,
        toolCalls: [{ id: "c", name: "f", arguments: "{}" }],
      },
      "m",
    );
    expect(without.choices[0]?.message.tool_calls?.[0]).not.toHaveProperty("thoughtSignature");

    const withSig = buildCompletion(
      {
        content: "",
        finishReason: "tool_calls",
        usage: null,
        toolCalls: [{ id: "c", name: "f", arguments: "{}", thoughtSignature: "SIG" }],
      },
      "m",
    );
    expect(withSig.choices[0]?.message.tool_calls?.[0]?.thoughtSignature).toBe("SIG");
  });

  it("attaches warnings to top level of completion when non-empty", () => {
    const out = buildCompletion(
      {
        content: "hello",
        finishReason: "stop",
        usage: null,
        toolCalls: [],
      },
      "gemini-3.8-flash",
      [{ field: "seed", reason: "ignored" }],
    );
    expect(out.warnings).toEqual([{ field: "seed", reason: "ignored" }]);
  });

  it("omits warnings from top level when empty or undefined", () => {
    const withoutWarnings = buildCompletion(
      {
        content: "hello",
        finishReason: "stop",
        usage: null,
        toolCalls: [],
      },
      "gemini-3.8-flash",
    );
    expect(withoutWarnings).not.toHaveProperty("warnings");

    const withEmptyWarnings = buildCompletion(
      {
        content: "hello",
        finishReason: "stop",
        usage: null,
        toolCalls: [],
      },
      "gemini-3.8-flash",
      [],
    );
    expect(withEmptyWarnings).not.toHaveProperty("warnings");
  });

  it("includes warnings from result.warnings if present", () => {
    const out = buildCompletion(
      {
        content: "hello",
        finishReason: "stop",
        usage: null,
        toolCalls: [],
        warnings: [{ field: "temperature", reason: "adjusted" }],
      },
      "gemini-3.8-flash",
    );
    expect(out.warnings).toEqual([{ field: "temperature", reason: "adjusted" }]);
  });
});

describe("buildChunk and sseEvent", () => {
  it("formats a delta chunk", () => {
    const chunk = buildChunk("chatcmpl-1", "m", 1, { content: "oi" }, null);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]?.delta.content).toBe("oi");
    expect(chunk).not.toHaveProperty("warnings");
    expect(chunk).not.toHaveProperty("usage");
  });

  it("includes reasoning_content in delta chunk when present", () => {
    const chunk = buildChunk("id-1", "gemini-3.8-flash", 1234567890, { reasoning_content: "Thinking..." }, null);
    expect(chunk.choices[0]?.delta.reasoning_content).toBe("Thinking...");
    expect(chunk.choices[0]?.delta.content).toBeUndefined();
  });

  it("attaches warnings and usage to chunk when provided in options", () => {
    const chunk = buildChunk("chatcmpl-1", "m", 1, { content: "" }, "stop", {
      warnings: [{ field: "seed", reason: "ignored" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(chunk.warnings).toEqual([{ field: "seed", reason: "ignored" }]);
    expect(chunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(chunk.choices[0]?.finish_reason).toBe("stop");
  });

  it("allows custom choices such as choices: [] in options", () => {
    const chunk = buildChunk("chatcmpl-1", "m", 1, {}, null, {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(chunk.choices).toEqual([]);
    expect(chunk.usage?.total_tokens).toBe(15);
  });

  it("serializes as an SSE event and sets the terminator", () => {
    expect(sseEvent({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});

describe("toOpenAIErrorBody", () => {
  it("preserves an upstream 4xx instead of flattening it to 502", () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const mapped = toOpenAIErrorBody(err, 502);
    expect(mapped.status).toBe(429);
    expect(mapped.body.error.type).toBe("rate_limit_error");
  });

  it("uses the fallback for 5xx and for an error without status", () => {
    expect(toOpenAIErrorBody(Object.assign(new Error("x"), { status: 500 }), 502).status).toBe(502);
    expect(toOpenAIErrorBody(new Error("x"), 502).status).toBe(502);
  });

  it("never hands an invalid status to the reply", () => {
    // Measured (2026-10-16): an upstream error carried status 0 through to
    // reply.status(0), which Fastify rejects with FST_ERR_BAD_STATUS_CODE and turns
    // into a 500 in the error handler. A detected status that is not a real 4xx is
    // ignored (the fallback wins), and an invalid fallback becomes 500.
    expect(toOpenAIErrorBody(Object.assign(new Error("x"), { status: 0 }), 502).status).toBe(502);
    expect(toOpenAIErrorBody(Object.assign(new Error("x"), { status: 42 }), 502).status).toBe(502);
    expect(toOpenAIErrorBody(new Error("x"), 0).status).toBe(500);
    expect(toOpenAIErrorBody(new Error("x"), -1).status).toBe(500);
  });

  it("marks 400 as invalid_request_error", () => {
    const mapped = toOpenAIErrorBody(new Error("bad"), 400);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.type).toBe("invalid_request_error");
  });

  it("brands 404 errors as invalid_request_error with model_not_found code", () => {
    const result = toOpenAIErrorBody(new Error("Model 'gpt-5' not found"), 404);
    expect(result.status).toBe(404);
    expect(result.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "model_not_found",
    });
  });
});
