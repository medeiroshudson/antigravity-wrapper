import { randomUUID } from "node:crypto";
import type { ChatToolCall } from "./compose.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

/** Allowlist for the legacy `parameters` field (spec §8). */
const LEGACY_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractToolDefs(body: unknown): ToolDef[] {
  const record = asRecord(body);
  const tools = record && Array.isArray(record.tools) ? record.tools : [];
  const out: ToolDef[] = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    const fn = tool ? asRecord(tool.function) : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

export function toolChoiceMode(choice: unknown): "none" | "required" | "auto" | { name: string } {
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  const record = asRecord(choice);
  const fn = record ? asRecord(record.function) : null;
  if (record?.type === "function" && fn && typeof fn.name === "string") return { name: fn.name };
  return "auto";
}

function resolveLocalPointer(ref: string, root: unknown): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    current = record[key];
  }
  return current;
}

/**
 * Sentinel for "schema not resolved", distinct from `null`.
 * `null` is valid JSON Schema content (`default`, `const`, `enum`,
 * `examples`, `properties` values), so it cannot carry the meaning of
 * failure: using it as the sentinel would make a valid tool vanish silently.
 */
const UNRESOLVED = Symbol("unresolved");

/** Reduces the schema to the legacy allowlist. Property names are NOT filtered. */
function toLegacySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toLegacySchema);
  const record = asRecord(schema);
  if (!record) return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!LEGACY_ALLOW.has(key)) continue;
    if (key === "properties") {
      const props = asRecord(value);
      if (!props) continue;
      out.properties = Object.fromEntries(
        Object.entries(props).map(([name, sub]) => [name, toLegacySchema(sub)]),
      );
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((v) => typeof v === "string")) continue;
    out[key] = toLegacySchema(value);
  }
  return out;
}

/**
 * Dereferences local `$ref`s; returns `UNRESOLVED` when a reference does not
 * resolve (or there is a cycle). A literal `null` passes through as ordinary
 * content.
 */
function dereference(schema: unknown, root: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(schema)) {
    const out: unknown[] = [];
    for (const item of schema) {
      const resolved = dereference(item, root, seen);
      if (resolved === UNRESOLVED) return UNRESOLVED;
      out.push(resolved);
    }
    return out;
  }
  const record = asRecord(schema);
  if (!record) return schema;

  const ref = record.$ref;
  if (typeof ref === "string") {
    if (seen.has(ref)) return UNRESOLVED;
    const target = resolveLocalPointer(ref, root);
    if (target === undefined) return UNRESOLVED;
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    const { $ref: _ignored, ...siblings } = record;
    const resolvedTarget = dereference(target, root, nextSeen);
    if (resolvedTarget === UNRESOLVED) return UNRESOLVED;
    const resolvedSiblings = dereference(siblings, root, seen);
    if (resolvedSiblings === UNRESOLVED) return UNRESOLVED;
    const targetRecord = asRecord(resolvedTarget);
    const siblingRecord = asRecord(resolvedSiblings);
    if (targetRecord && siblingRecord) return { ...targetRecord, ...siblingRecord };
    return resolvedTarget;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "$defs" || key === "definitions" || key === "$schema") continue;
    const resolved = dereference(value, root, seen);
    if (resolved === UNRESOLVED) return UNRESOLVED;
    out[key] = resolved;
  }
  return out;
}

function isClaudeOrGptOss(runtimeModel: string): boolean {
  return runtimeModel.startsWith("claude-") || runtimeModel.startsWith("gpt-oss-");
}

/**
 * Builds the `functionDeclarations` in the family's encoding (spec §8).
 * Gemini receives full JSON Schema; Claude/GPT-OSS receive the legacy field with
 * the allowlist, because there the backend rejects an invalid schema with 400
 * instead of accepting it with 200 and silently not calling the tool.
 */
export function buildFunctionDeclarations(
  tools: ToolDef[],
  runtimeModel: string,
): { functionDeclarations: unknown[] } | undefined {
  if (tools.length === 0) return undefined;
  const legacy = isClaudeOrGptOss(runtimeModel);
  const declarations: unknown[] = [];

  for (const tool of tools) {
    const dereferenced = dereference(tool.parameters, tool.parameters);
    if (dereferenced === UNRESOLVED) continue; // unresolvable schema: omit the tool
    const schema = asRecord(dereferenced) ?? {};
    const normalized = { type: "object", properties: {}, ...schema };
    declarations.push({
      name: tool.name,
      description: tool.description,
      ...(legacy ? { parameters: toLegacySchema(normalized) } : { parametersJsonSchema: normalized }),
    });
  }

  return declarations.length > 0 ? { functionDeclarations: declarations } : undefined;
}

/**
 * Text instruction that emulates `tool_choice`.
 * The backend ignores `toolConfig.functionCallingConfig.mode` (measured), so the
 * caller's intent has to travel in the prompt. No fence: stacking a block
 * instruction makes the model answer with text that does not satisfy the schema.
 *
 * Table (spec §8): `auto`/absent -> nothing; `none` -> explicit refusal; `required`
 * -> exactly one; named -> that function. For `none` we choose to send the
 * declarations AND the refusal in the prompt (instead of omitting the tools):
 * it preserves the catalog for the model and keeps all emulation in one place,
 * the prompt.
 */
export function toolInstruction(tools: ToolDef[], choice: unknown): string | null {
  if (tools.length === 0) return null;
  const mode = toolChoiceMode(choice);
  if (mode === "auto") return null;
  if (mode === "none") return "Rule: Do not call any tool; answer with text only.";

  const catalog = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const rule =
    typeof mode === "object"
      ? `Call the tool "${mode.name}".`
      : "Call exactly one of the listed tools.";

  return ["Available tools:", catalog, `Rule: ${rule}`].join("\n");
}

export function normalizeToolCalls(parts: Array<Record<string, unknown>>): ChatToolCall[] {
  const out: ChatToolCall[] = [];
  for (const part of parts) {
    const call = asRecord(part.functionCall);
    if (!call || typeof call.name !== "string" || call.name.length === 0) continue;
    const id = typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${randomUUID()}`;
    out.push({
      id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      ...(typeof part.thoughtSignature === "string" && part.thoughtSignature
        ? { thoughtSignature: part.thoughtSignature }
        : {}),
    });
  }
  return out;
}
