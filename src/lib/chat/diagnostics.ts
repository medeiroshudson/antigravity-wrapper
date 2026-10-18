/**
 * Diagnostic warning emitted when a request parameter is ignored, dropped,
 * or degraded instead of failing silently.
 */
export interface Warning {
  field: string;
  reason: string;
}

/**
 * Declared OpenAI request fields that are ignored upstream by Antigravity
 * without failing the caller request.
 */
export const DECLARED_IGNORED_FIELDS: readonly string[] = [
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "seed",
  "user",
  "parallel_tool_calls",
  "service_tier",
  "store",
  "metadata",
] as const;

/**
 * Diagnostic accumulator used across the request pipeline to collect non-fatal
 * warnings to be attached to completions or streaming chunks.
 */
export class WarningCollector {
  private readonly warnings: Warning[] = [];

  add(field: string, reason: string): void {
    this.warnings.push({ field, reason });
  }

  addWarning(warning: Warning): void {
    this.warnings.push(warning);
  }

  addAll(warnings: readonly Warning[]): void {
    this.warnings.push(...warnings);
  }

  get length(): number {
    return this.warnings.length;
  }

  hasWarnings(): boolean {
    return this.warnings.length > 0;
  }

  toArray(): Warning[] {
    return [...this.warnings];
  }
}
