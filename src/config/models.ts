export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const EFFORTS: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** An unknown effort must not break the request: it falls back to "off". */
export function normalizeEffort(raw: unknown): ReasoningEffort {
  return typeof raw === "string" && (EFFORTS as readonly string[]).includes(raw)
    ? (raw as ReasoningEffort)
    : "off";
}

export interface PublicModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export const PUBLIC_MODELS: readonly PublicModel[] = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 1_048_576, maxTokens: 65_535 },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 131_072, maxTokens: 32_768 },
];

/** id publico -> runtime id por esforco. `default` cobre off/minimal. */
const ROUTING: Record<string, Partial<Record<ReasoningEffort, string>> & { default: string }> = {
  "gemini-3.8-flash": {
    default: "gemini-3.8-flash-low",
    minimal: "gemini-3.8-flash-low",
    low: "gemini-3.8-flash-low",
    medium: "gemini-3.8-flash-medium",
    high: "gemini-3.8-flash-high",
    xhigh: "gemini-3.8-flash-high",
  },
  "gemini-3.7-flash": {
    default: "gemini-3.7-flash-low",
    minimal: "gemini-3.7-flash-low",
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high",
    xhigh: "gemini-3.7-flash-high",
  },
  "gemini-3.6-flash": {
    default: "gemini-3.6-flash-low",
    minimal: "gemini-3.6-flash-low",
    low: "gemini-3.6-flash-low",
    medium: "gemini-3.6-flash-medium",
    high: "gemini-3.6-flash-high",
    xhigh: "gemini-3.6-flash-high",
  },
  "gemini-3.5-flash": {
    default: "gemini-3.5-flash-extra-low",
    minimal: "gemini-3.5-flash-extra-low",
    low: "gemini-3.5-flash-extra-low",
    medium: "gemini-3.5-flash-low",
    high: "gemini-3-flash-agent",
    xhigh: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    default: "gemini-3.1-pro-low",
    minimal: "gemini-3.1-pro-low",
    low: "gemini-3.1-pro-low",
    medium: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
    xhigh: "gemini-pro-agent",
  },
  "gpt-oss-120b": { default: "gpt-oss-120b-medium" },
};

export function resolveRuntimeModel(publicId: string, effort: ReasoningEffort): string {
  const route = ROUTING[publicId];
  if (!route) return publicId;
  return route[effort] ?? route.default;
}

const MAX_OUTPUT: Record<string, number> = {
  "gpt-oss-120b-medium": 32_768,
  "gemini-3.1-pro-low": 65_535,
  "gemini-pro-agent": 65_535,
};

export function getMaxOutputTokens(runtimeModel: string): number {
  const exact = MAX_OUTPUT[runtimeModel];
  if (exact !== undefined) return exact;
  if (runtimeModel.startsWith("gpt-oss-")) return 32_768;
  if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") return 65_535;
  if (runtimeModel.startsWith("gemini-")) return 65_536;
  return 64_000;
}

/** Valores de thinkingBudget do CLI oficial, por familia. */
export function getThinkingConfig(
  runtimeModel: string,
  effort: ReasoningEffort,
): { includeThoughts: boolean; thinkingBudget: number } {
  if (effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
  const high = effort === "high" || effort === "xhigh";

  if (runtimeModel.startsWith("claude-")) return { includeThoughts: true, thinkingBudget: 1024 };
  if (runtimeModel.startsWith("gpt-oss-")) return { includeThoughts: true, thinkingBudget: 8192 };
  if (runtimeModel.startsWith("gemini-3.5-flash") || runtimeModel === "gemini-3-flash-agent") {
    return { includeThoughts: true, thinkingBudget: high ? 10_000 : effort === "medium" ? 4_000 : 1_000 };
  }
  if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
    return { includeThoughts: true, thinkingBudget: high ? 10_001 : 1_001 };
  }
  if (runtimeModel.startsWith("gemini-")) {
    return { includeThoughts: true, thinkingBudget: high ? -1 : effort === "medium" ? 4_000 : 1_000 };
  }
  return { includeThoughts: false, thinkingBudget: 0 };
}

let discovered: PublicModel[] = [...PUBLIC_MODELS];

export function getPublicModels(): readonly PublicModel[] {
  return discovered;
}

/** Merges an account's catalog into the static table, so discovered ids become selectable. */
export function applyDiscoveredModels(models: Record<string, unknown>): void {
  const merged = new Map(PUBLIC_MODELS.map((model) => [model.id, model]));
  for (const rawId of Object.keys(models)) {
    const id = rawId.trim();
    if (!/^(gemini-|claude-|gpt-oss-)/i.test(id)) continue;
    if (/^(chat_|tab_)/i.test(id) || /image/i.test(id)) continue;
    const publicId = id.replace(/-(low|medium|high|extra-low|extra-high|thinking|tiered)$/, "");
    if (!merged.has(publicId)) {
      merged.set(publicId, {
        id: publicId,
        name: publicId,
        contextWindow: 0,
        maxTokens: getMaxOutputTokens(id),
      });
    }
  }
  discovered = [...merged.values()];
}

export function resetDiscoveredModelsForTests(): void {
  discovered = [...PUBLIC_MODELS];
}
