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

  it("inlines $ref references from local $defs into properties", () => {
    const inputSchema = {
      type: "object",
      properties: {
        user: { $ref: "#/$defs/User" },
      },
      $defs: {
        User: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      },
    };
    const result = buildResponseFormatConfig(
      {
        type: "json_schema",
        json_schema: { name: "UserPayload", schema: inputSchema },
      },
      true,
    );

    expect(result.responseMimeType).toBe("application/json");
    expect(result.responseSchema).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      },
    });
    expect(result.warnings).toHaveLength(0);
  });

  it("inlines $ref references from definitions and handles nested refs", () => {
    const inputSchema = {
      type: "object",
      properties: {
        order: { $ref: "#/definitions/Order" },
      },
      definitions: {
        Order: {
          type: "object",
          properties: {
            item: { $ref: "#/definitions/Item" },
          },
        },
        Item: {
          type: "object",
          properties: {
            sku: { type: "string" },
          },
        },
      },
    };
    const result = buildResponseFormatConfig(
      {
        type: "json_schema",
        json_schema: { name: "OrderPayload", schema: inputSchema },
      },
      true,
    );

    expect(result.responseSchema).toEqual({
      type: "object",
      properties: {
        order: {
          type: "object",
          properties: {
            item: {
              type: "object",
              properties: {
                sku: { type: "string" },
              },
            },
          },
        },
      },
    });
  });

  it("sanitizes disallowed keywords inside inlined definitions", () => {
    const inputSchema = {
      type: "object",
      properties: {
        profile: { $ref: "#/$defs/Profile" },
      },
      $defs: {
        Profile: {
          type: "object",
          properties: {
            nickname: { type: "string", default: "anonymous", examples: ["anon1"] },
          },
        },
      },
    };
    const result = buildResponseFormatConfig(
      {
        type: "json_schema",
        json_schema: { name: "ProfilePayload", schema: inputSchema },
      },
      true,
    );

    expect(result.responseSchema).toEqual({
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            nickname: { type: "string" },
          },
        },
      },
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        field: "response_format.json_schema",
        reason: expect.stringMatching(/default|examples/),
      }),
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
