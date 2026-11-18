import type { GeminiContent, GeminiPart } from "../antigravity/envelope.js";

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
 *
 * Medido em 2026-11-18, no `gemini-4-hydrogen-sonar`:
 * - a frase de identidade do Codex numa mensagem de usuário → 429 em duas contas, com quota
 *   em 88%/92%, prompt neutro de 240k tokens em 200 e o mesmo request sem a frase em 200.
 *   O scanner do upstream olha o conteúdo, não só a `systemInstruction`, então realocar o
 *   papel não repara esse caso: a frase precisa ser reescrita onde está.
 *
 * Frases relatadas por outros gateways (CLIProxyAPI, oh-my-pi) ainda não medidas aqui —
 * `<system-conventions>`, a lista RFC 2119 completa, "Hermes Agent"/"Nous Research" — ficam
 * fora até existir uma substituição segura para cada uma: gatilho em forma de tag não pode
 * ser renomeado sem quebrar a prosa que referencia o nome da tag.
 */
export type CompatibilityMode = "off" | "log" | "on";

/** Onde a regra olha: a system instruction, ou todas as partes de texto do request. */
export type CompatibilityField = "systemInstruction" | "content";

/**
 * O que a regra faz quando casa.
 *
 * `relocate-system-to-first-user` move a system instruction inteira para o primeiro turno de
 * usuário: medido 2026-11-15, o upstream recusa o literal no papel de sistema e aceita o
 * mesmo texto no papel de usuário.
 *
 * `mask-literal` reescreve o literal onde ele estiver, com a substituição declarada na
 * regra. Zero-width não é oferecido de propósito: o upstream despe esses caracteres antes
 * de casar, então a técnica já nasce derrotada.
 */
export type CompatibilityAction =
  | { kind: "relocate-system-to-first-user"; marker: string }
  | { kind: "mask-literal"; replacement: string };

export interface CompatibilityRule {
  id: string;
  when: { field: CompatibilityField; literal: string; caseInsensitive: boolean };
  action: CompatibilityAction;
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
  /** Caracteres casados: o tamanho da system instruction, ou a soma dos literais. */
  chars: number;
  applied: boolean;
  /** Por que não foi aplicada, quando aplicável. */
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

/** Substitui todas as ocorrências do literal, devolvendo quantos caracteres casaram. */
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
 * Reescreve o literal em toda parte de texto do request: turnos de usuário e modelo, e o
 * `output` dos resultados de ferramenta. Argumentos de `functionCall` e partes de `thought`
 * ficam intactos: mexer nos primeiros corromperia uma chamada, e as segundas carregam a
 * assinatura de continuidade do modelo.
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

/** Prefixa o texto no primeiro turno do usuário, sem duplicar quando já prefixado. */
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
 * Aplica as regras conforme o modo. `off` não avalia nada; `log` avalia e reporta sem mudar
 * o request; `on` aplica todas as regras que casarem, em sequência.
 *
 * Idempotência: a realocação esvazia a `systemInstruction` e a máscara remove o literal, então
 * uma segunda passagem não encontra o que casar e não faz nada.
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
