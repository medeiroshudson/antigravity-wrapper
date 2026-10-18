import { t } from "../../i18n/index.js";
import type { Warning } from "./diagnostics.js";
import { dereference, UNRESOLVED } from "./tools.js";

/**
 * Disallowed keywords in Google Gemini JSON schemas that must be stripped.
 */
const DISALLOWED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$definitions",
  "definitions",
  "const",
  "default",
  "examples",
]);

function sanitizeNode(node: unknown, stripped: Set<string>): unknown {
  if (node === null || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => sanitizeNode(item, stripped));
  }

  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (DISALLOWED_KEYWORDS.has(key)) {
      stripped.add(key);
      continue;
    }

    if (
      (key === "properties" || key === "patternProperties") &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const propsOut: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(value as Record<string, unknown>)) {
        propsOut[propKey] = sanitizeNode(propVal, stripped);
      }
      out[key] = propsOut;
      continue;
    }

    out[key] = sanitizeNode(value, stripped);
  }

  return out;
}

/**
 * Recursively strips OpenAPI / JSON schema keywords unsupported by Gemini
 * ($schema, $id, $ref, $defs, $definitions, const, default, examples).
 */
export function sanitizeResponseSchema(schema: Record<string, unknown>): {
  sanitized: Record<string, unknown>;
  strippedKeywords: string[];
} {
  const stripped = new Set<string>();
  const sanitized = (sanitizeNode(schema, stripped) ?? {}) as Record<string, unknown>;
  return {
    sanitized,
    strippedKeywords: Array.from(stripped),
  };
}

export interface ResponseFormatConfig {
  responseMimeType?: string;
  responseSchema?: unknown;
  warnings: Warning[];
}

/**
 * Translates an incoming OpenAI `response_format` into Gemini `responseMimeType`
 * and sanitized `responseSchema`, respecting the kill-switch and capturing diagnostics.
 */
export function buildResponseFormatConfig(
  format: unknown,
  isEnabled: boolean,
): ResponseFormatConfig {
  if (format == null || typeof format !== "object") {
    return { warnings: [] };
  }

  const fmt = format as Record<string, unknown>;
  const type = fmt.type;

  if (type === "text") {
    return { warnings: [] };
  }

  if (type !== "json_object" && type !== "json_schema") {
    return {
      warnings: [
        {
          field: "response_format.type",
          reason: t("warn.unrecognizedField", { field: "response_format.type" }),
        },
      ],
    };
  }

  if (!isEnabled) {
    return {
      warnings: [
        {
          field: "response_format",
          reason: t("warn.disabledGenConfig"),
        },
      ],
    };
  }

  if (type === "json_object") {
    return {
      responseMimeType: "application/json",
      warnings: [],
    };
  }

  // type === "json_schema"
  const jsonSchemaWrapper = fmt.json_schema;
  let schemaToSanitize: Record<string, unknown> | undefined;

  if (
    jsonSchemaWrapper &&
    typeof jsonSchemaWrapper === "object" &&
    !Array.isArray(jsonSchemaWrapper)
  ) {
    const wrapper = jsonSchemaWrapper as Record<string, unknown>;
    if (wrapper.schema && typeof wrapper.schema === "object" && !Array.isArray(wrapper.schema)) {
      schemaToSanitize = wrapper.schema as Record<string, unknown>;
    } else if ("properties" in wrapper || "type" in wrapper) {
      schemaToSanitize = wrapper;
    }
  }

  const warnings: Warning[] = [];
  let responseSchema: unknown;

  if (schemaToSanitize) {
    const dereferenced = dereference(schemaToSanitize);
    const candidate =
      dereferenced !== UNRESOLVED &&
      typeof dereferenced === "object" &&
      dereferenced !== null &&
      !Array.isArray(dereferenced)
        ? (dereferenced as Record<string, unknown>)
        : schemaToSanitize;
    const { sanitized, strippedKeywords } = sanitizeResponseSchema(candidate);
    responseSchema = sanitized;
    if (strippedKeywords.length > 0) {
      warnings.push({
        field: "response_format.json_schema",
        reason: t("warn.droppedSchemaKeywords", { keywords: strippedKeywords.join(", ") }),
      });
    }
  }

  return {
    responseMimeType: "application/json",
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    warnings,
  };
}
