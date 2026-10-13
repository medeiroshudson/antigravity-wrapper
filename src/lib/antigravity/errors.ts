import { redact } from "../../config/index.js";

export type UpstreamFailureKind =
  | "quota"
  | "transient_rate_limit"
  | "auth"
  | "validation_required"
  | "license"
  | "model_not_found"
  | "client_error"
  | "server_error";

export class UpstreamError extends Error {
  override name = "UpstreamError";
  constructor(
    readonly kind: UpstreamFailureKind,
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(redact(message).slice(0, 500));
    Object.setPrototypeOf(this, UpstreamError.prototype);
  }
}

/** "Resets in 2h 30m" / "Resets in 45m" / "Resets in 30s" -> milliseconds. */
function parseResetHint(body: string): number | null {
  const match = /Resets?\s+in\s+([^.\n]+)/i.exec(body);
  const fragment = match?.[1];
  if (!fragment) return null;
  let totalMs = 0;
  let matched = false;
  const hours = /(\d+)\s*h/i.exec(fragment);
  const minutes = /(\d+)\s*m(?!s)/i.exec(fragment);
  const seconds = /(\d+)\s*s/i.exec(fragment);
  if (hours) { totalMs += Number(hours[1]) * 3_600_000; matched = true; }
  if (minutes) { totalMs += Number(minutes[1]) * 60_000; matched = true; }
  if (seconds) { totalMs += Number(seconds[1]) * 1_000; matched = true; }
  return matched ? totalMs : null;
}

/**
 * A reset window below this threshold is transient throttling, not a quota wall:
 * imposing a real cooldown for "Resets in 30s" would burn the account over a
 * momentary delay. The threshold mirrors the default transient cooldown
 * (`COOLDOWN_TRANSIENT_MS`, 60 s); a window at or above it is still a wall, and the
 * `resetTime` itself is used as the cooldown duration.
 */
const SHORT_RESET_THRESHOLD_MS = 60_000;

function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
  }
  return body;
}

export function classifyUpstream(status: number, body: string): UpstreamError {
  const text = messageOf(body);

  if (status === 429) {
    const retryAfterMs = parseResetHint(body);
    // A real quota wall carries a long "Resets in …"; a short window is just
    // throttling. Without the hint, the backend uses RESOURCE_EXHAUSTED for
    // transient throttling too, which deserves a retry.
    if (retryAfterMs !== null && retryAfterMs >= SHORT_RESET_THRESHOLD_MS) {
      return new UpstreamError("quota", status, text, retryAfterMs);
    }
    const quotaWall =
      retryAfterMs === null &&
      !/rate.?limit/i.test(text) &&
      /quota exceeded|exceeded your|limit reached|reached your|daily limit|individual quota/i.test(text);
    return quotaWall
      ? new UpstreamError("quota", status, text, null)
      : new UpstreamError("transient_rate_limit", status, text);
  }
  if (status === 401) return new UpstreamError("auth", status, text);
  if (status === 403) {
    if (/VALIDATION_REQUIRED/i.test(body)) return new UpstreamError("validation_required", status, text);
    if (/valid license of this product/i.test(text)) return new UpstreamError("license", status, text);
    return new UpstreamError("client_error", status, text);
  }
  if (status === 404) return new UpstreamError("model_not_found", status, text);
  if (status >= 400 && status < 500) return new UpstreamError("client_error", status, text);
  return new UpstreamError("server_error", status, text);
}
