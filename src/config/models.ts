export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type EffortLevel = ReasoningEffort;

export const EFFORTS: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class InvalidEffortError extends Error {
  constructor(raw: string) {
    super(`Invalid reasoning_effort '${raw}'. Supported values: ${EFFORTS.join(", ")}`);
    this.name = "InvalidEffortError";
  }
}

/**
 * Normalizes reasoning effort input.
 * Undefined, null, empty string, or non-string falls back to "medium" per OpenAI standard.
 * An unrecognized non-empty string throws InvalidEffortError (spec D6).
 */
export function normalizeEffort(raw: unknown): ReasoningEffort {
  if (raw === undefined || raw === null || raw === "") return "medium";
  if (typeof raw === "string") {
    if ((EFFORTS as readonly string[]).includes(raw)) {
      return raw as ReasoningEffort;
    }
    throw new InvalidEffortError(raw);
  }
  return "medium";
}

/** One entry as the catalog reports it. Numbers are null when the backend omits them. */
export interface CatalogEntry {
  id: string;
  displayName: string | null;
  maxTokens: number | null;
  maxOutputTokens: number | null;
  supportsThinking: boolean;
  thinkingBudget: number | null;
  /** The backend's model enum, the value the client puts in `labels.model_enum`. */
  backendEnum?: string | null;
  /** The backend's own thinking level for the model, when it reports one. */
  thinkingLevel?: number | null;
}

export interface CatalogVariant {
  runtimeId: string;
  /** The effort suffix this runtime id carried, or null for the canonical id. */
  suffix: string | null;
  degree: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  thinkingBudget: number;
  backendEnum: string | null;
  thinkingLevel: number | null;
}

export interface CatalogModel {
  id: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  variants: CatalogVariant[];
}

/**
 * The effort suffixes, longest first so `-extra-low` is consumed before `-low` matches
 * inside it. `-lite`, `-pro` and `-flash` are absent on purpose: they are identity, not
 * effort (spec D2, D3).
 */
const EFFORT_SUFFIXES = ["extra-low", "extra-high", "low", "medium", "high", "thinking", "tiered", "agent"] as const;

/**
 * How much reasoning a suffix asks for. 2 is the canonical id with no suffix. An
 * unrecognised suffix takes the canonical degree rather than throwing.
 */
const DEGREE: Record<string, number> = {
  "extra-low": 0,
  low: 1,
  medium: 3,
  thinking: 3,
  high: 4,
  "extra-high": 4,
  tiered: 4,
  agent: 4,
};
const CANONICAL_DEGREE = 2;

/** The degree each effort asks for; -1 means "the lowest this model offers". */
const TARGET_DEGREE: Record<ReasoningEffort, number> = {
  off: -1,
  minimal: -1,
  low: 1,
  medium: 3,
  high: 4,
  xhigh: 4,
};

const FALLBACK_MAX_OUTPUT_TOKENS = 64_000;

function isCatalogModel(id: string): boolean {
  if (!/^(gemini-|claude-|gpt-)/i.test(id)) return false;
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id) && id.toLowerCase() !== "gemini-3.1-flash-image") return false;
  return true;
}

function splitSuffix(runtimeId: string): { base: string; suffix: string | null } {
  for (const suffix of EFFORT_SUFFIXES) {
    if (runtimeId.endsWith(`-${suffix}`)) {
      return { base: runtimeId.slice(0, -(suffix.length + 1)), suffix };
    }
  }
  return { base: runtimeId, suffix: null };
}

/** The backend's label with its effort parenthesis removed, or the fallback. */
function labelOf(entry: CatalogEntry, fallback: string): string {
  const raw = entry.displayName?.trim();
  if (!raw || raw === "-") return fallback;
  const stripped = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped.length > 0 ? stripped : fallback;
}

/**
 * The registry keyed by public id. It **accumulates**: discovery runs per account, so a
 * second account's catalog adds to the first rather than replacing it. That is what makes
 * the advertised list the union of the pool (spec D8) and what keeps the last good catalog
 * across a failed refresh (spec §8).
 */
let registry = new Map<string, CatalogModel>();

/**
 * Folds catalog entries into the registry.
 *
 * Entries are sorted by runtime id first, so the outcome does not depend on the backend's
 * JSON key order: a group's label and its variant order are then the same on every run.
 */
export function applyCatalog(entries: readonly CatalogEntry[]): void {
  for (const entry of [...entries].sort((left, right) => left.id.localeCompare(right.id))) {
    const runtimeId = entry.id.trim();
    if (!isCatalogModel(runtimeId)) continue;

    const { base, suffix } = splitSuffix(runtimeId);
    const variant: CatalogVariant = {
      runtimeId,
      suffix,
      degree: suffix === null ? CANONICAL_DEGREE : (DEGREE[suffix] ?? CANONICAL_DEGREE),
      maxOutputTokens: entry.maxOutputTokens ?? 0,
      supportsThinking: entry.supportsThinking,
      thinkingBudget: entry.thinkingBudget ?? 0,
      backendEnum: entry.backendEnum ?? null,
      thinkingLevel: entry.thinkingLevel ?? null,
    };

    const existing = registry.get(base);
    if (existing) {
      if (!existing.variants.some((known) => known.runtimeId === runtimeId)) {
        existing.variants.push(variant);
      }
      // A real label beats a fallback wherever in the group it arrives: the `-tiered`
      // entry carries "-", so without this a group could be labelled by its id.
      if (existing.label === existing.id) {
        const label = labelOf(entry, existing.id);
        if (label !== existing.id) existing.label = label;
      }
      continue;
    }

    registry.set(base, {
      id: base,
      label: labelOf(entry, base),
      contextWindow: entry.maxTokens ?? 0,
      maxTokens: entry.maxOutputTokens ?? 0,
      variants: [variant],
    });
  }
}

export function getPublicModels(): readonly CatalogModel[] {
  return [...registry.values()];
}

function findVariant(runtimeId: string): CatalogVariant | undefined {
  for (const model of registry.values()) {
    const found = model.variants.find((variant) => variant.runtimeId === runtimeId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The runtime id to send for a public id at a given effort (spec D5, D6).
 *
 * Nearest degree to what the effort asks, ties going **down** so a request is never
 * silently promoted to a more expensive model; among variants that are equally near, the
 * one whose suffix matches the effort name wins, then the lower degree, then the
 * lexicographically first id. A group with one variant returns it for every effort, which
 * is what makes `claude-opus-4-6` reach `claude-opus-4-6-thinking`.
 */
export function resolveRuntimeModel(publicId: string, effort: ReasoningEffort): string {
  const model = registry.get(publicId);
  if (!model || model.variants.length === 0) return publicId;
  const [only] = model.variants;
  if (model.variants.length === 1 && only) return only.runtimeId;

  const variants = [...model.variants].sort((left, right) =>
    left.runtimeId.localeCompare(right.runtimeId),
  );
  const requested = TARGET_DEGREE[effort];
  const target =
    requested < 0 ? Math.min(...variants.map((variant) => variant.degree)) : requested;

  let nearest = Number.POSITIVE_INFINITY;
  for (const variant of variants) {
    nearest = Math.min(nearest, Math.abs(variant.degree - target));
  }
  const candidates = variants.filter((variant) => Math.abs(variant.degree - target) === nearest);

  const byName = candidates.find((variant) => variant.suffix === effort);
  if (byName) return byName.runtimeId;

  const lowest = Math.min(...candidates.map((variant) => variant.degree));
  const tied = candidates.filter((variant) => variant.degree === lowest);
  const [chosen] = tied;
  return (chosen ?? variants[0])?.runtimeId ?? publicId;
}

/**
 * The thinking levels the backend accepts, in its own spelling (protojson drops the
 * `THINKING_LEVEL_` prefix, so the wire value is `HIGH`, not `THINKING_LEVEL_HIGH`).
 */
export type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "MODEL_DEFAULT";

/**
 * Variant degree -> wire level. Measured 2026-11-09: the installed client sends
 * `thinkingLevel: "HIGH"` for `gemini-3.8-flash-high`, whose variant degree is 4 here. The
 * catalog's numeric `thinkingLevel` is *not* the enum ordinal (that model reports 3 while
 * the client sends HIGH), so the degree ladder is what maps, and an unknown degree falls
 * back to `MODEL_DEFAULT` rather than guessing.
 */
const LEVEL_BY_DEGREE: Record<number, ThinkingLevel> = {
  0: "MINIMAL",
  1: "LOW",
  3: "MEDIUM",
  4: "HIGH",
};

export interface ThinkingConfig {
  includeThoughts: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Only for a variant whose degree has no level mapping, and for the off switch. */
  thinkingBudget?: number;
}

/** The catalog's own thinking setting, with `off` still forcing thinking away. */
export function getThinkingConfig(runtimeId: string, effort: ReasoningEffort): ThinkingConfig {
  if (effort === "off") return { includeThoughts: false };
  const variant = findVariant(runtimeId);
  if (!variant || !variant.supportsThinking) return { includeThoughts: false };
  const level = LEVEL_BY_DEGREE[variant.degree];
  return level === undefined
    ? { includeThoughts: true, thinkingBudget: variant.thinkingBudget }
    : { includeThoughts: true, thinkingLevel: level };
}

/** The backend's model enum for a runtime id, as `labels.model_enum` expects it. */
export function getModelEnum(runtimeId: string): string | null {
  return findVariant(runtimeId)?.backendEnum ?? null;
}

export function getMaxOutputTokens(runtimeId: string): number {
  const variant = findVariant(runtimeId);
  if (!variant || variant.maxOutputTokens <= 0) return FALLBACK_MAX_OUTPUT_TOKENS;
  return variant.maxOutputTokens;
}

/**
 * Resolves the reasoning effort levels supported by a model.
 * Returns undefined when thinking is not supported by any variant.
 */
export function getSupportedEfforts(model: CatalogModel): string[] | undefined {
  const supportsThinking = model.variants.some((v) => v.supportsThinking);
  if (!supportsThinking) return undefined;

  const explicitEfforts = new Set<string>();
  for (const v of model.variants) {
    if (v.suffix === "low") explicitEfforts.add("low");
    if (v.suffix === "medium") explicitEfforts.add("medium");
    if (v.suffix === "high") explicitEfforts.add("high");
    if (v.suffix === "extra-high") explicitEfforts.add("xhigh");
  }

  if (explicitEfforts.size > 1) {
    const order = ["low", "medium", "high", "xhigh"];
    return order.filter((e) => explicitEfforts.has(e));
  }

  const id = model.id.toLowerCase();
  if (id.startsWith("gemini-")) {
    return ["low", "medium", "high"];
  }
  if (id.includes("opus") || id.startsWith("gpt-5") || id.startsWith("gpt-6")) {
    return ["low", "medium", "high", "xhigh"];
  }
  return ["low", "medium", "high"];
}

export function resetRegistryForTests(): void {
  registry = new Map<string, CatalogModel>();
}
