import { describe, expect, it } from "vitest";
import {
  buildChunk,
  buildCompletion,
  sseEvent,
  SSE_DONE,
  toOpenAIErrorBody,
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
});

describe("buildChunk and sseEvent", () => {
  it("formats a delta chunk", () => {
    const chunk = buildChunk("chatcmpl-1", "m", 1, { content: "oi" }, null);
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]?.delta.content).toBe("oi");
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

  it("marks 400 as invalid_request_error", () => {
    const mapped = toOpenAIErrorBody(new Error("bad"), 400);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.type).toBe("invalid_request_error");
  });
});
