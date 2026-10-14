export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const EFFORTS: readonly ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** An unknown effort must not break the request: it falls back to "off". */
export function normalizeEffort(raw: unknown): ReasoningEffort {
  return typeof raw === "string" && (EFFORTS as readonly string[]).includes(raw)
    ? (raw as ReasoningEffort)
    : "off";
}

/** One entry as the catalog reports it. Numbers are null when the backend omits them. */
export interface CatalogEntry {
  id: string;
  displayName: string | null;
  maxTokens: number | null;
  maxOutputTokens: number | null;
  supportsThinking: boolean;
  thinkingBudget: number | null;
}

export interface CatalogVariant {
  runtimeId: string;
  /** The effort suffix this runtime id carried, or null for the canonical id. */
  suffix: string | null;
  degree: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  thinkingBudget: number;
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
  if (/image/i.test(id)) return false;
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

/** The catalog's own budget for the model, with `off` still forcing thinking away. */
export function getThinkingConfig(
  runtimeId: string,
  effort: ReasoningEffort,
): { includeThoughts: boolean; thinkingBudget: number } {
  if (effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
  const variant = findVariant(runtimeId);
  if (!variant || !variant.supportsThinking) return { includeThoughts: false, thinkingBudget: 0 };
  return { includeThoughts: true, thinkingBudget: variant.thinkingBudget };
}

export function getMaxOutputTokens(runtimeId: string): number {
  const variant = findVariant(runtimeId);
  if (!variant || variant.maxOutputTokens <= 0) return FALLBACK_MAX_OUTPUT_TOKENS;
  return variant.maxOutputTokens;
}

export function resetRegistryForTests(): void {
  registry = new Map<string, CatalogModel>();
}
