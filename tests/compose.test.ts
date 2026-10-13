import { describe, expect, it } from "vitest";
import { toContents } from "../src/lib/chat/compose.js";

describe("toContents", () => {
  it("separates the system message from the history", () => {
    const out = toContents([
      { role: "system", content: "Voce e um assistente." },
      { role: "user", content: "oi" },
    ]);
    expect(out.systemInstruction).toBe("Voce e um assistente.");
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "oi" }] }]);
  });

  it("accepts content as blocks in the Anthropic format", () => {
    const out = toContents([{ role: "user", content: [{ type: "text", text: "ola" }] }]);
    expect(out.contents[0]?.parts[0]).toEqual({ text: "ola" });
  });

  it("maps an assistant with tool_calls to functionCall", () => {
    const out = toContents([
      { role: "user", content: "clima?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":20}' },
    ]);
    expect(out.contents[1]?.role).toBe("model");
    expect(out.contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: "get_weather", args: { city: "Paris" }, id: "call_1" },
    });
    expect(out.contents[2]?.role).toBe("user");
    expect(out.contents[2]?.parts[0]).toMatchObject({
      functionResponse: { name: "get_weather", response: { output: '{"temp":20}' }, id: "call_1" },
    });
  });

  it("preserves thoughtSignature when present on the call", () => {
    const out = toContents([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" }, thoughtSignature: "SIG" },
        ],
      },
    ]);
    expect(out.contents[0]?.parts[0]).toMatchObject({ thoughtSignature: "SIG" });
  });

  it("treats invalid arguments as an empty object", () => {
    const out = toContents([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{not json" } }],
      },
    ]);
    expect(out.contents[0]?.parts[0]).toMatchObject({ functionCall: { args: {} } });
  });

  it("marks an error in the functionResponse", () => {
    const out = toContents([{ role: "tool", tool_call_id: "c", name: "f", content: "error: falhou" }]);
    expect(out.contents[0]?.parts[0]).toMatchObject({
      functionResponse: { response: { error: "error: falhou" } },
    });
  });

  it("does not emit an empty turn when the content is null without tool_calls", () => {
    expect(toContents([{ role: "assistant", content: null }]).contents).toEqual([]);
  });

  it("throws on an empty list", () => {
    expect(() => toContents([])).toThrow(/non-empty/i);
  });
});
