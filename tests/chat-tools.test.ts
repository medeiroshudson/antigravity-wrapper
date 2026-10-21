import { describe, expect, it } from "vitest";
import {
  buildFunctionDeclarations,
  extractToolDefs,
  normalizeToolCalls,
  toolChoiceMode,
  toolInstruction,
  usesLegacyEncoding,
} from "../src/lib/chat/tools.js";

const BODY = {
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Clima",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ],
};

describe("extractToolDefs", () => {
  it("extracts name, description and parameters", () => {
    const defs = extractToolDefs(BODY);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("get_weather");
  });

  it("ignores entries without a name and returns empty without tools", () => {
    expect(extractToolDefs({ tools: [{ function: {} }] })).toEqual([]);
    expect(extractToolDefs({})).toEqual([]);
  });
});

describe("toolChoiceMode", () => {
  it("recognizes none, required, named and auto", () => {
    expect(toolChoiceMode("none")).toBe("none");
    expect(toolChoiceMode("required")).toBe("required");
    expect(toolChoiceMode({ type: "function", function: { name: "x" } })).toEqual({ name: "x" });
    expect(toolChoiceMode(undefined)).toBe("auto");
  });
});

describe("buildFunctionDeclarations", () => {
  it("uses parametersJsonSchema on the Gemini path, with the schema intact", () => {
    const out = buildFunctionDeclarations(extractToolDefs(BODY), "gemini-3.8-flash-low");
    const decl = out?.functionDeclarations[0] as Record<string, unknown>;
    expect(decl.parametersJsonSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
    expect(decl.parameters).toBeUndefined();
  });

  it("uses the legacy field and filters the allowlist on the Claude path", () => {
    const tools = [
      {
        name: "t",
        description: "d",
        parameters: {
          type: "object",
          properties: { a: { type: "string", format: "hostname" }, b: { anyOf: [{ type: "string" }] } },
          required: ["a"],
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
    ];
    const decl = buildFunctionDeclarations(tools, "claude-sonnet-4-6")?.functionDeclarations[0] as Record<
      string,
      unknown
    >;
    expect(decl.parametersJsonSchema).toBeUndefined();
    expect(decl.parameters).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: {} },
      required: ["a"],
    });
  });

  it("omits a tool whose $ref does not resolve, instead of sending an invalid schema", () => {
    const tools = [
      { name: "quebrada", description: "d", parameters: { type: "object", properties: { a: { $ref: "#/nope" } } } },
      { name: "ok", description: "d", parameters: { type: "object", properties: {} } },
    ];
    const names = (
      buildFunctionDeclarations(tools, "claude-sonnet-4-6")?.functionDeclarations as Array<{ name: string }>
    ).map((d) => d.name);
    expect(names).toEqual(["ok"]);
  });

  it("preserves a literal null in the schema instead of omitting the tool", () => {
    const tools = [
      {
        name: "com_null",
        description: "d",
        parameters: {
          type: "object",
          properties: { a: { type: "string", default: null }, b: { const: null } },
          examples: [null],
        },
      },
    ];
    const decl = buildFunctionDeclarations(tools, "gemini-3.8-flash-low")?.functionDeclarations[0] as Record<
      string,
      unknown
    >;
    expect(decl.name).toBe("com_null");
    expect(decl.parametersJsonSchema).toEqual({
      type: "object",
      properties: { a: { type: "string", default: null }, b: { const: null } },
      examples: [null],
    });
  });

  it("omits a tool with a $ref cycle and returns undefined (cycle guard)", () => {
    const tools = [
      {
        name: "ciclica",
        description: "d",
        parameters: { type: "object", properties: { next: { $ref: "#" } } },
      },
    ];
    const out = buildFunctionDeclarations(tools, "claude-sonnet-4-6");
    expect(out.declarations).toBeUndefined();
    expect(out.diagnostics).toContainEqual(
      expect.objectContaining({ field: "tools[0].function.name:ciclica" })
    );
  });

  it("returns undefined declarations without tools", () => {
    const out = buildFunctionDeclarations([], "gemini-3.8-flash-low");
    expect(out.declarations).toBeUndefined();
    expect(out.diagnostics).toEqual([]);
  });

  it("records diagnostic warning when unresolvable $ref causes tool omission", () => {
    const result = buildFunctionDeclarations([
      { type: "function", function: { name: "broken", parameters: { $ref: "#/missing" } } },
    ], "gemini-2.5-flash");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ field: "tools[0].function.name:broken" })
    );
  });

  it("records diagnostic warning when legacy keywords are dropped on Claude/GPT path", () => {
    const result = buildFunctionDeclarations([
      {
        type: "function",
        function: {
          name: "test_tool",
          parameters: {
            type: "object",
            properties: {
              foo: { type: "string", format: "uri" },
              bar: { anyOf: [{ type: "string" }] },
            },
            additionalProperties: false,
          },
        },
      },
    ], "claude-sonnet-4-6");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        field: "tools[0].parameters",
        reason: expect.stringMatching(/unsupported schema keywords were dropped/i),
      })
    );
  });
});

describe("toolInstruction", () => {
  it("does not instruct in auto mode or when absent", () => {
    const defs = extractToolDefs(BODY);
    expect(toolInstruction(defs, "auto")).toBeNull();
    expect(toolInstruction(defs, undefined)).toBeNull();
  });

  it("instructs not to call tools in none mode, without a fence", () => {
    const text = toolInstruction(extractToolDefs(BODY), "none");
    expect(text).toMatch(/do not call any tool/i);
    expect(text).not.toContain("```");
  });

  it("does not instruct when there are no tools, in any mode", () => {
    expect(toolInstruction([], "none")).toBeNull();
    expect(toolInstruction([], "required")).toBeNull();
  });

  it("names the function in named mode, without a fence", () => {
    const text = toolInstruction(extractToolDefs(BODY), { type: "function", function: { name: "get_weather" } });
    expect(text).toContain("get_weather");
    expect(text).not.toContain("```");
  });

  it("requires exactly one call in required mode, without a fence", () => {
    const text = toolInstruction(extractToolDefs(BODY), "required");
    expect(text).toMatch(/exactly one/i);
    expect(text).not.toContain("```");
  });
});

describe("normalizeToolCalls", () => {
  it("converts functionCall to an OpenAI tool_call, preserving the signature", () => {
    const calls = normalizeToolCalls([
      { functionCall: { name: "get_weather", args: { city: "Paris" }, id: "call_1" }, thoughtSignature: "SIG" },
    ]);
    expect(calls[0]?.function?.name).toBe("get_weather");
    expect(calls[0]?.function?.arguments).toBe('{"city":"Paris"}');
    expect(calls[0]?.thoughtSignature).toBe("SIG");
  });

  it("generates a synthetic id when the backend returns no id", () => {
    expect(normalizeToolCalls([{ functionCall: { name: "f", args: {} } }])[0]?.id).toMatch(/^call_/);
  });

  it("guarantees unique tool call IDs when upstream emits colliding IDs across invocations", () => {
    const part = { functionCall: { name: "test_fn", args: {}, id: "call_22930" } };
    const first = normalizeToolCalls([part]);
    const second = normalizeToolCalls([part]);

    expect(first[0]?.id).toBeDefined();
    expect(second[0]?.id).toBeDefined();
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect(first[0]?.id).toMatch(/^call_22930_/);
  });

  it("ignores parts without functionCall", () => {
    expect(normalizeToolCalls([{ text: "oi" }])).toEqual([]);
  });
});

describe("the tool schema encoding per family", () => {
  it("gives a non-oss GPT model the legacy encoding, like the rest of the 3p group", () => {
    // The OpenAI bridge rejects the JSON-Schema keywords the Gemini path accepts, so the
    // family test must cover the whole family, not just `gpt-oss-`.
    expect(usesLegacyEncoding("gpt-5-medium")).toBe(true);
    expect(usesLegacyEncoding("gpt-oss-120b-medium")).toBe(true);
    expect(usesLegacyEncoding("claude-opus-4-6-thinking")).toBe(true);
    expect(usesLegacyEncoding("gemini-3.8-flash-high")).toBe(false);
  });
});
