import { describe, expect, it } from "vitest";
import { buildResponseFormatConfig, sanitizeResponseSchema } from "../src/lib/chat/schema-sanitizer.js";

describe("buildResponseFormatConfig", () => {
  it("translates json_object to application/json mime type", () => {
    const result = buildResponseFormatConfig({ type: "json_object" }, true);
    expect(result.responseMimeType).toBe("application/json");
    expect(result.responseSchema).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it("translates json_schema and sanitizes disallowed keywords", () => {
    const inputSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      $schema: "http://json-schema.org/draft-07/schema#",
      default: {},
    };
    const result = buildResponseFormatConfig(
      {
        type: "json_schema",
        json_schema: { name: "User", schema: inputSchema },
      },
      true,
    );

    expect(result.responseMimeType).toBe("application/json");
    expect(result.responseSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: "response_format.json_schema" }),
    );
  });

  it("emits warning and skips mapping when kill-switch is disabled", () => {
    const result = buildResponseFormatConfig({ type: "json_object" }, false);
    expect(result.responseMimeType).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ reason: expect.stringMatching(/kill-switch|disabled/i) }),
    );
  });

  it("skips mapping json_schema when kill-switch is disabled", () => {
    const result = buildResponseFormatConfig(
      {
        type: "json_schema",
        json_schema: { name: "User", schema: { type: "object" } },
      },
      false,
    );
    expect(result.responseMimeType).toBeUndefined();
    expect(result.responseSchema).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ reason: expect.stringMatching(/kill-switch|disabled/i) }),
    );
  });

  it("treats text format as no-op without warnings", () => {
    const result = buildResponseFormatConfig({ type: "text" }, true);
    expect(result.responseMimeType).toBeUndefined();
    expect(result.responseSchema).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it("handles null or undefined format gracefully", () => {
    expect(buildResponseFormatConfig(undefined, true)).toEqual({ warnings: [] });
    expect(buildResponseFormatConfig(null, true)).toEqual({ warnings: [] });
  });

  it("warns on unrecognized format type", () => {
    const result = buildResponseFormatConfig({ type: "yaml" }, true);
    expect(result.responseMimeType).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: "response_format.type" }),
    );
  });
});

describe("sanitizeResponseSchema", () => {
  it("strips all disallowed keywords recursively while keeping valid schema keywords", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "http://example.com/user.json",
      $defs: { Unused: { type: "string" } },
      definitions: { AlsoUnused: { type: "string" } },
      type: "object",
      required: ["name", "profile"],
      properties: {
        name: {
          type: "string",
          default: "unknown",
          examples: ["Alice", "Bob"],
        },
        profile: {
          type: "object",
          properties: {
            role: {
              type: "string",
              const: "admin",
            },
            refItem: {
              $ref: "#/definitions/AlsoUnused",
            },
          },
        },
      },
    };

    const { sanitized, strippedKeywords } = sanitizeResponseSchema(input);

    expect(sanitized).toEqual({
      type: "object",
      required: ["name", "profile"],
      properties: {
        name: {
          type: "string",
        },
        profile: {
          type: "object",
          properties: {
            role: {
              type: "string",
            },
            refItem: {},
          },
        },
      },
    });

    expect(strippedKeywords).toEqual(
      expect.arrayContaining([
        "$schema",
        "$id",
        "$defs",
        "definitions",
        "default",
        "examples",
        "const",
        "$ref",
      ]),
    );
  });

  it("preserves property keys named like disallowed keywords in properties object", () => {
    const input = {
      type: "object",
      properties: {
        default: {
          type: "string",
          default: "foo",
        },
        examples: {
          type: "array",
          items: { type: "string" },
        },
      },
    };

    const { sanitized, strippedKeywords } = sanitizeResponseSchema(input);

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        default: {
          type: "string",
        },
        examples: {
          type: "array",
          items: { type: "string" },
        },
      },
    });

    expect(strippedKeywords).toEqual(["default"]);
  });

  it("handles anyOf, allOf, oneOf arrays and item objects", () => {
    const input = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
            examples: ["urgent"],
          },
        },
        either: {
          anyOf: [
            { type: "string", const: "fixed" },
            { type: "number" },
          ],
        },
      },
    };

    const { sanitized, strippedKeywords } = sanitizeResponseSchema(input);

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
          },
        },
        either: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });

    expect(strippedKeywords).toEqual(expect.arrayContaining(["examples", "const"]));
  });
});
