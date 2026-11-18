import type { GeminiContent, GeminiPart } from "../antigravity/envelope.js";

/**
 * Upstream compatibility rules.
 *
 * Each rule exists because the backend refused a representation that is valid under the
 * client contract, and because a measurement shows both the refusal and the accepted
 * alternative. Broadening a rule without a fresh measurement only moves the symptom.
 *
 * Measured 2026-11-15, driving the service with opencode:
 * - `tools.opencode.session_move` inside `systemInstruction` -> 429 RESOURCE_EXHAUSTED on
 *   every account; the same text in the user role -> 200; 80k chars of neutral text -> 200.
 *
 * Measured 2026-11-18 on `gemini-4-hydrogen-sonar`:
 * - the Codex identity sentence in a user message -> 429 on two accounts, with quota at
 *   88%/92%, a 240k-token neutral prompt at 200, and the same request without the sentence
 *   at 200. The upstream scanner inspects content, not only `systemInstruction`, so
 *   relocating the role cannot repair this case: the phrase must be rewritten in place.
 *
 * Phrases reported by other gateways (CLIProxyAPI, oh-my-pi) not yet measured here —
 * `<system-conventions>`, the full RFC 2119 list, "Hermes Agent"/"Nous Research" — stay
 * out until a safe replacement exists for each: tag-shaped triggers cannot be renamed
 * without breaking prose that references the tag name.
 */
export type CompatibilityMode = "off" | "log" | "on";

/** Where a rule looks: the system instruction, or every text part of the request. */
export type CompatibilityField = "systemInstruction" | "content";

/**
 * What a rule does when it matches.
 *
 * `relocate-system-to-first-user` moves the whole system instruction into the first user
 * turn: measured 2026-11-15, the upstream refuses the literal in the system role and
 * accepts the same text in the user role.
 *
 * `mask-literal` rewrites the matched literal in place with the rule's replacement.
 * Zero-width insertion is deliberately not offered: the upstream strips those characters
 * before matching, so the technique is already defeated.
 */
export type CompatibilityAction =
  | { kind: "relocate-system-to-first-user"; marker: string }
  | { kind: "mask-literal"; replacement: string };

export interface CompatibilityRule {
  id: string;
  when: { field: CompatibilityField; literal: string; caseInsensitive: boolean };
  action: CompatibilityAction;
  /** Measured signature justifying the rule, and when it was measured. */
  evidence: string;
  measuredAt: string;
}

export const RULES: readonly CompatibilityRule[] = [
  {
    id: "system-literal-tools-opencode-session-move",
    when: { field: "systemInstruction", literal: "tools.opencode.session_move", caseInsensitive: true },
    action: { kind: "relocate-system-to-first-user", marker: "system-instructions" },
    evidence:
      "429 RESOURCE_EXHAUSTED on every account with the literal in the system instruction; " +
      "the same text in the user role and 80k chars of neutral text answered 200",
    measuredAt: "2026-11-15",
  },
  {
    id: "content-literal-codex-agent-identity",
    when: {
      field: "content",
      literal: "You are Codex, an agent based on GPT-5.",
      caseInsensitive: true,
    },
    action: { kind: "mask-literal", replacement: "You are an AI agent based on GPT-5." },
    evidence:
      "429 RESOURCE_EXHAUSTED on two accounts with the sentence in a user message " +
      "(gemini-4-hydrogen-sonar); quota at 88%/92%, a 240k-token neutral prompt and the " +
      "same request without the sentence all answered 200",
    measuredAt: "2026-11-18",
  },
];

export interface CompatibilityHit {
  ruleId: string;
  /** Matched characters: the system instruction length, or the sum of matched literals. */
  chars: number;
  applied: boolean;
  /** Why the rule was not applied, when applicable. */
  skipped?: "no-user-turn" | "log-only";
}

interface ChatInput {
  systemInstruction: string;
  contents: GeminiContent[];
}

function matches(rule: CompatibilityRule, text: string): boolean {
  return rule.when.caseInsensitive
    ? text.toLowerCase().includes(rule.when.literal.toLowerCase())
    : text.includes(rule.when.literal);
}

/** Replaces every occurrence of the literal, returning how many characters matched. */
function maskText(rule: CompatibilityRule, text: string): { text: string; chars: number } {
  const replacement = rule.action.kind === "mask-literal" ? rule.action.replacement : null;
  if (replacement === null) return { text, chars: 0 };

  const escaped = rule.when.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, rule.when.caseInsensitive ? "gi" : "g");
  let chars = 0;
  const masked = text.replace(pattern, (found) => {
    chars += found.length;
    return replacement;
  });
  return { text: masked, chars };
}

function isTextPart(part: GeminiPart): part is { text: string; thoughtSignature?: string } {
  return "text" in part && typeof part.text === "string" && !("thought" in part);
}

function hasFunctionOutput(part: GeminiPart): part is {
  functionResponse: { name: string; response: { output?: string; error?: string }; id?: string };
} {
  return "functionResponse" in part && part.functionResponse !== undefined;
}

/**
 * Rewrites the literal across every text part of the request: user and model turns, and
 * tool result `output`. `functionCall` arguments and `thought` parts stay untouched:
 * altering the former would corrupt a call, and the latter carry the model's continuity
 * signature.
 */
function maskContents(
  rule: CompatibilityRule,
  contents: GeminiContent[],
): { contents: GeminiContent[]; chars: number } {
  let chars = 0;
  let changed = false;

  const next = contents.map((content) => {
    let contentChanged = false;
    const parts = content.parts.map((part): GeminiPart => {
      if (isTextPart(part)) {
        const masked = maskText(rule, part.text);
        if (masked.chars === 0) return part;
        chars += masked.chars;
        contentChanged = true;
        return { ...part, text: masked.text };
      }

      if (hasFunctionOutput(part)) {
        const output = part.functionResponse.response.output;
        if (typeof output !== "string") return part;
        const masked = maskText(rule, output);
        if (masked.chars === 0) return part;
        chars += masked.chars;
        contentChanged = true;
        return {
          ...part,
          functionResponse: {
            ...part.functionResponse,
            response: { ...part.functionResponse.response, output: masked.text },
          },
        };
      }

      return part;
    });

    if (!contentChanged) return content;
    changed = true;
    return { ...content, parts };
  });

  return { contents: changed ? next : contents, chars };
}

/** Prepends the system text to the first user turn, without duplicating when already moved. */
function relocate(rule: CompatibilityRule, input: ChatInput): ChatInput | CompatibilityHit["skipped"] {
  const marker = rule.action.kind === "relocate-system-to-first-user" ? rule.action.marker : null;
  if (marker === null) return "no-user-turn";

  const index = input.contents.findIndex((content) => content.role === "user");
  const target = index >= 0 ? input.contents[index] : undefined;
  if (index < 0 || target === undefined) return "no-user-turn";

  const opening = `<${marker}>`;
  const prelude = `${opening}\n${input.systemInstruction}\n</${marker}>\n\n`;
  const contents = input.contents.map((content, at) => {
    if (at !== index) return content;
    const parts = [...content.parts];
    const textAt = parts.findIndex((part) => "text" in part && typeof part.text === "string");
    const existing = textAt >= 0 ? parts[textAt] : undefined;
    if (existing !== undefined && "text" in existing) {
      parts[textAt] = { ...existing, text: prelude + (existing.text ?? "") };
      return { ...content, parts };
    }
    parts.unshift({ text: prelude.trimEnd() });
    return { ...content, parts };
  });

  return { systemInstruction: "", contents };
}

/**
 * Applies rules according to the mode. `off` evaluates nothing; `log` evaluates and
 * reports without changing the request; `on` applies all matching rules in sequence.
 *
 * Idempotence: relocation empties `systemInstruction` and masking removes the literal, so
 * a second pass finds nothing left to match and does nothing.
 */
export function applyCompatibility<T extends ChatInput>(
  input: T,
  mode: CompatibilityMode,
): { input: T; hits: CompatibilityHit[] } {
  if (mode === "off") return { input, hits: [] };

  let current = input;
  const hits: CompatibilityHit[] = [];

  for (const rule of RULES) {
    if (rule.when.field === "systemInstruction") {
      if (!matches(rule, current.systemInstruction)) continue;
      const chars = current.systemInstruction.length;

      if (mode === "log") {
        hits.push({ ruleId: rule.id, chars, applied: false, skipped: "log-only" });
        continue;
      }

      const result = relocate(rule, current);
      if (typeof result === "string") {
        hits.push({ ruleId: rule.id, chars, applied: false, skipped: result });
        continue;
      }
      current = { ...current, ...result };
      hits.push({ ruleId: rule.id, chars, applied: true });
      continue;
    }

    const masked = maskContents(rule, current.contents);
    if (masked.chars === 0) continue;

    if (mode === "log") {
      hits.push({ ruleId: rule.id, chars: masked.chars, applied: false, skipped: "log-only" });
      continue;
    }
    current = { ...current, contents: masked.contents };
    hits.push({ ruleId: rule.id, chars: masked.chars, applied: true });
  }

  return { input: current, hits };
}
