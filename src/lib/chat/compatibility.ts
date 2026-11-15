import type { GeminiContent } from "../antigravity/envelope.js";

/**
 * Regras de compatibilidade com o upstream.
 *
 * Cada regra existe porque o backend recusou uma representação que é válida no contrato do
 * cliente, e porque existe medida que mostra a recusa e a alternativa aceita. Ampliar uma
 * regra sem medida nova é como trocar o sintoma de lugar.
 *
 * Medido em 2026-11-15, dirigindo o serviço com o opencode:
 * - `tools.opencode.session_move` dentro da `systemInstruction` → 429 RESOURCE_EXHAUSTED em
 *   todas as contas; o mesmo texto no papel de usuário → 200; texto neutro de 80k chars → 200.
 */
export interface CompatibilityRule {
  id: string;
  when: { field: "systemInstruction"; literal: string; caseInsensitive: boolean };
  action: { kind: "relocate-system-to-first-user"; marker: string };
  /** Assinatura medida que justifica a regra, e quando foi medida. */
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
];

export type CompatibilityMode = "off" | "log" | "on";

export interface CompatibilityHit {
  ruleId: string;
  chars: number;
  applied: boolean;
  /** Por que não foi aplicada, quando aplicável. */
  skipped?: "no-user-turn" | "log-only";
}

interface ChatInput {
  systemInstruction: string;
  contents: GeminiContent[];
}

function matches(rule: CompatibilityRule, system: string): boolean {
  return rule.when.caseInsensitive
    ? system.toLowerCase().includes(rule.when.literal.toLowerCase())
    : system.includes(rule.when.literal);
}

/** Prefixa o texto no primeiro turno do usuário, sem duplicar quando já prefixado. */
function relocate(rule: CompatibilityRule, input: ChatInput): ChatInput | CompatibilityHit["skipped"] {
  const index = input.contents.findIndex((content) => content.role === "user");
  const target = index >= 0 ? input.contents[index] : undefined;
  if (index < 0 || target === undefined) return "no-user-turn";

  const opening = `<${rule.action.marker}>`;
  const prelude = `${opening}\n${input.systemInstruction}\n</${rule.action.marker}>\n\n`;
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
 * Aplica as regras conforme o modo. `log` avalia e reporta sem mudar o request; `on` aplica a
 * primeira regra que casar (o texto vai íntegro, só muda de papel); `off` não avalia nada.
 *
 * A operação é idempotente por construção: ela esvazia a `systemInstruction`, então uma
 * segunda passagem não encontra o literal e não faz nada.
 */
export function applyCompatibility<T extends ChatInput>(
  input: T,
  mode: CompatibilityMode,
): { input: T; hits: CompatibilityHit[] } {
  if (mode === "off") return { input, hits: [] };

  for (const rule of RULES) {
    if (!matches(rule, input.systemInstruction)) continue;
    const chars = input.systemInstruction.length;

    if (mode === "log") {
      return { input, hits: [{ ruleId: rule.id, chars, applied: false, skipped: "log-only" }] };
    }

    const result = relocate(rule, input);
    if (typeof result === "string") {
      return { input, hits: [{ ruleId: rule.id, chars, applied: false, skipped: result }] };
    }
    return { input: { ...input, ...result }, hits: [{ ruleId: rule.id, chars, applied: true }] };
  }

  return { input, hits: [] };
}
