import { describe, expect, it } from "vitest";
import { toContents } from "../src/lib/chat/compose.js";
import { rememberSignature } from "../src/lib/chat/signatures.js";

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

  it("resolves the functionResponse name from the paired call when the tool message omits it", () => {
    // `name` on a tool message is optional in the OpenAI API — clients pair by
    // tool_call_id. Fabricating a placeholder made the native Gemini path reject the
    // whole request with a generic 400 (measured), because functionResponse.name must
    // name the functionCall it answers.
    const out = toContents([
      { role: "user", content: "clima?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":20}' },
    ]);
    expect(out.contents[2]?.parts[0]).toMatchObject({
      functionResponse: { name: "get_weather", id: "call_1" },
    });
  });

  it("prefers the paired functionCall name over a disagreeing tool message name", () => {
    const out = toContents([
      { role: "user", content: "clima?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "tool", content: "ok" },
    ]);
    expect(out.contents[2]?.parts[0]).toMatchObject({ functionResponse: { name: "get_weather" } });
  });

  it("keeps the explicit name when the call cannot be paired", () => {
    const out = toContents([{ role: "tool", tool_call_id: "ghost", name: "solo", content: "x" }]);
    expect(out.contents[0]?.parts[0]).toMatchObject({ functionResponse: { name: "solo" } });
  });

  it("textualizes an assistant tool call that cannot be signed, keeping the signed ones", () => {
    // A call the wrapper never signed (made before a restart, or by the 3p bridge
    // which returns no signatures) cannot be reconstructed: sending it unsigned makes
    // the native Gemini path reject the whole request. It becomes an equivalent text
    // part; a call the bank does know keeps its functionCall form.
    rememberSignature("call_banked", "SIG-BANKED");
    const out = toContents(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_banked", type: "function", function: { name: "banked_tool", arguments: '{"path":"/a"}' } },
            { id: "call_lost", type: "function", function: { name: "lost_tool", arguments: '{"path":"/b"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_banked", content: "banked result" },
        { role: "tool", tool_call_id: "call_lost", content: "lost result" },
      ],
      { strictThoughtSignatures: true },
    );
    const modelTurn = out.contents.find((c) => c.role === "model");
    expect(modelTurn?.parts).toEqual([
      expect.objectContaining({ functionCall: expect.objectContaining({ name: "banked_tool" }), thoughtSignature: "SIG-BANKED" }),
      { text: expect.stringMatching(/lost_tool/) },
    ]);
  });

  it("textualizes the orphan tool result of an unsigned call", () => {
    rememberSignature("call_banked", "SIG-BANKED");
    const out = toContents(
      [
        { role: "assistant", content: null, tool_calls: [{ id: "call_lost", type: "function", function: { name: "lost_tool", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_lost", content: "orphan result" },
      ],
      { strictThoughtSignatures: true },
    );
    // The user turn carrying the orphan response must not emit a functionResponse
    // part: there is no functionCall for it to answer.
    const parts = out.contents.flatMap((c) => c.parts);
    expect(parts.some((p) => "functionResponse" in p && p.functionResponse.name === "lost_tool")).toBe(false);
    expect(parts.some((p) => "text" in p && /orphan result/.test(p.text))).toBe(true);
  });

  it("keeps the functionCall form when signatures are not strict", () => {
    const out = toContents([
      { role: "assistant", content: null, tool_calls: [{ id: "call_lost", type: "function", function: { name: "lost_tool", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_lost", content: "r" },
    ]);
    const parts = out.contents.flatMap((c) => c.parts);
    expect(parts.some((p) => "functionCall" in p)).toBe(true);
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

  it("records diagnostic warning when image or audio content blocks are dropped", () => {
    const result = toContents([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: "http://example.com/a.png" } } as any,
        ],
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ field: "messages[0].content[1].image_url" })
    );
  });

  it("records diagnostic warning when tool call arguments are invalid JSON", () => {
    const result = toContents([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{malformed" } }],
      },
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ field: "messages[0].tool_calls[0].function.arguments" })
    );
  });

  it("preserves distinct functionResponse names when tool_call_id is reused across different turns", () => {
    const messages = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_duplicate", type: "function", function: { name: "toolA", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_duplicate",
        content: "result A",
      },
      { role: "user", content: "second prompt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_duplicate", type: "function", function: { name: "toolB", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_duplicate",
        content: "result B",
      },
    ];

    const out = toContents(messages, { strictThoughtSignatures: false });
    // Turn 0: user "first prompt"
    // Turn 1: model toolA
    // Turn 2: user functionResponse toolA + "second prompt"
    // Turn 3: model toolB
    // Turn 4: user functionResponse toolB
    const responseTurn1 = out.contents[2]?.parts.find((p) => "functionResponse" in p);
    const responseTurn2 = out.contents[4]?.parts.find((p) => "functionResponse" in p);

    expect((responseTurn1 as any)?.functionResponse?.name).toBe("toolA");
    expect((responseTurn2 as any)?.functionResponse?.name).toBe("toolB");
  });

  it("does not textualize a signed tool call when a prior turn textualized a call with the same ID", () => {
    const messages = [
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_duplicate", type: "function", function: { name: "toolA", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_duplicate",
        content: "result A",
      },
      { role: "user", content: "second prompt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_duplicate",
            type: "function",
            function: { name: "toolB", arguments: "{}" },
            thoughtSignature: "SIG-VALID",
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_duplicate",
        content: "result B",
      },
    ];

    const out = toContents(messages, { strictThoughtSignatures: true });
    // In turn 1 (first assistant), call_duplicate had no signature and was textualized.
    // In turn 2 (tool response A), it was textualized into a user text turn.
    // In turn 3 (second assistant), call_duplicate HAS a valid signature, so it should NOT be textualized.
    // In turn 4 (tool response B), it should emit a proper functionResponse with name "toolB".
    const modelTurn2 = out.contents[3];
    const userTurn2 = out.contents[4];

    const functionCallPart = modelTurn2?.parts.find((p) => "functionCall" in p);
    expect(functionCallPart).toMatchObject({
      functionCall: { name: "toolB", id: "call_duplicate" },
      thoughtSignature: "SIG-VALID",
    });

    const functionResponsePart = userTurn2?.parts.find((p) => "functionResponse" in p);
    expect(functionResponsePart).toMatchObject({
      functionResponse: { name: "toolB", id: "call_duplicate" },
    });
  });
});

