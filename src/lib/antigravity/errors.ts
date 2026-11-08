import { redact } from "../../config/index.js";
import { t } from "../../i18n/index.js";

export type UpstreamFailureKind =
  | "quota"
  | "transient_rate_limit"
  | "auth"
  | "validation_required"
  | "account_blocked"
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
    /** Where the account owner appeals a block, when the backend names it. */
    readonly appealUrl: string | null = null,
  ) {
    super(redact(message).slice(0, 500));
    Object.setPrototypeOf(this, UpstreamError.prototype);
  }
}

/**
 * The client hung up before the answer was done. Not an upstream verdict, so it is not
 * an `UpstreamError`: the pool machinery must not treat it as an account failure (it is
 * not definitive-failover material either — measured, it burned a failover slot on a
 * dead request) and the route must not relay its status anywhere Fastify would reject.
 * `status` 499 (nginx's "client closed request") keeps `detectStatus`-style readers on
 * a valid HTTP code if the error ever leaks into a generic path.
 */
export class ClientDisconnectedError extends Error {
  override name = "ClientDisconnectedError";
  readonly status = 499;
  constructor(message: string = t("upstream.cancelledByClient")) {
    super(message);
    Object.setPrototypeOf(this, ClientDisconnectedError.prototype);
  }
}

/**
 * Kinds no other endpoint or account can repair: the request itself is the problem. A
 * missing model, a rejected request and a wrong client fingerprint fail identically
 * everywhere, so retrying them only spends endpoints and buries the cause.
 *
 * `auth`, `validation_required` and `account_blocked` are deliberately absent: each account
 * has its own token, its own verification state and its own Terms-of-Service standing, so
 * another account is a real remedy for those. Measured 2026-11-05: a `403 TOS_VIOLATION`
 * answered for eight accounts of the pool while two fresh ones served 200 in the same
 * process, under the same client id and User-Agent.
 */
const DEFINITIVE_KINDS: ReadonlySet<UpstreamFailureKind> = new Set([
  "model_not_found",
  "client_error",
  "license",
]);

export function isDefinitive(kind: UpstreamFailureKind): boolean {
  return DEFINITIVE_KINDS.has(kind);
}

/**
 * True when every account failed on a rate limit or a quota wall. There is nothing to fail
 * over to — the whole pool is out of quota — so the caller must receive a 429 it can back
 * off from, not a 503 `server_error` it will retry immediately (which is what turned a
 * drained Opus quota into an endless retry loop on the client side).
 */
export function isPoolRateLimited(failures: ReadonlyArray<{ kind: string }>): boolean {
  return (
    failures.length > 0 &&
    failures.every((failure) => failure.kind === "quota" || failure.kind === "transient_rate_limit")
  );
}

/** "2h 30m" / "45m" / "3h52m46.163670559s" -> milliseconds, or null when nothing parses. */
function parseDurationFragment(fragment: string): number | null {
  let totalMs = 0;
  let matched = false;
  const hours = /(\d+)\s*h/i.exec(fragment);
  const minutes = /(\d+)\s*m(?!s)/i.exec(fragment);
  const seconds = /(\d+(?:\.\d+)?)\s*s/i.exec(fragment);
  if (hours) { totalMs += Number(hours[1]) * 3_600_000; matched = true; }
  if (minutes) { totalMs += Number(minutes[1]) * 60_000; matched = true; }
  if (seconds) { totalMs += Math.round(Number(seconds[1]) * 1_000); matched = true; }
  return matched ? totalMs : null;
}

/**
 * "Resets in 2h 30m" / "Resets in 45m" / "reset after 4h46m21s" -> milliseconds.
 *
 * The backend uses two wordings: "Resets in <duration>" and "reset after <duration>".
 * Missing the second one classified a multi-hour quota wall as a transient throttle, so
 * nothing cooled the account and every request hammered the exhausted pool (measured).
 */
function parseResetHint(body: string): number | null {
  const match = /Resets?\s+in\s+([^.\n]+)/i.exec(body) ?? /reset\s+after\s+([^.\n]+)/i.exec(body);
  const fragment = match?.[1];
  return fragment ? parseDurationFragment(fragment) : null;
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

/**
 * The reset the backend states in a structured field, which is more durable than the
 * wording around it. A 429 carries either a `RetryInfo.retryDelay` in whole seconds
 * (e.g. "13966.163670559s") or an `ErrorInfo` `quotaResetDelay` (e.g. "3h52m46s"). It is
 * this signal — not the message text — that survives a backend that phrases the same wall
 * differently per endpoint.
 */
function parseStructuredReset(body: string): number | null {
  let parsed: { error?: { details?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  const details = parsed.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const record = detail as Record<string, unknown>;
    if (typeof record.retryDelay === "string") {
      const seconds = Number.parseFloat(record.retryDelay);
      if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    }
    const metadata = record.metadata;
    if (typeof metadata === "object" && metadata !== null) {
      const quotaResetDelay = (metadata as Record<string, unknown>).quotaResetDelay;
      if (typeof quotaResetDelay === "string") {
        const fromDescriptor = parseDurationFragment(quotaResetDelay);
        if (fromDescriptor !== null) return fromDescriptor;
      }
    }
  }
  return null;
}

/**
 * The block Google applies to one account, not to a request: a 403 whose `ErrorInfo`
 * carries `reason: "TOS_VIOLATION"`, with the appeal form in `metadata.appeal_url`.
 * The structured reason is the durable signal; the message is only a fallback, because
 * the same wording could accompany a request-level refusal.
 */
function parseAccountBlock(body: string): { appealUrl: string | null } | null {
  let parsed: { error?: { details?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  const details = parsed.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const record = detail as Record<string, unknown>;
    if (record.reason !== "TOS_VIOLATION") continue;
    const metadata =
      typeof record.metadata === "object" && record.metadata !== null
        ? (record.metadata as Record<string, unknown>)
        : {};
    const appealUrl = typeof metadata.appeal_url === "string" ? metadata.appeal_url : null;
    return { appealUrl };
  }
  return null;
}

export function classifyUpstream(status: number, body: string): UpstreamError {
  const text = messageOf(body);

  if (status === 429) {
    // The structured delay is authoritative; the message wording is only a fallback.
    const retryAfterMs = parseStructuredReset(body) ?? parseResetHint(body);
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
    // Order matters: a blocked account still carries a message the other branches could
    // match, and only this one leaves the account out of the pool.
    const block = parseAccountBlock(body);
    if (block !== null || /violation of terms of service/i.test(text)) {
      return new UpstreamError("account_blocked", status, text, null, block?.appealUrl ?? null);
    }
    if (/VALIDATION_REQUIRED/i.test(body)) return new UpstreamError("validation_required", status, text);
    if (/valid license of this product/i.test(text)) return new UpstreamError("license", status, text);
    return new UpstreamError("client_error", status, text);
  }
  if (status === 404) return new UpstreamError("model_not_found", status, text);
  if (status >= 400 && status < 500) return new UpstreamError("client_error", status, text);
  return new UpstreamError("server_error", status, text);
}
