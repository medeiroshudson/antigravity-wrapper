import { t } from "../i18n/index.js";

export const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;

export const DEFAULT_USER_AGENT =
  "antigravity/cli/1.2.4 (aidev_client; os_type=linux; armd64; cl=982146307; auth_method=consumer)";

const ALLOWED_HOST_SUFFIX = ".googleapis.com";
const ALLOWED_HOST_EXACT = "googleapis.com";

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.API_KEY;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(t("config.apiKeyMissing"));
  }
  if (!/^[^\s,]+$/.test(value)) {
    throw new Error(t("config.apiKeyInvalid"));
  }
  return value;
}

/** Google API hosts only: keeps a poisoned base URL from receiving the bearer token. */
export function assertSafeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(t("config.baseUrlInvalid", { value: raw }));
  }
  if (url.protocol !== "https:") {
    throw new Error(t("config.baseUrlNotHttps", { protocol: url.protocol }));
  }
  if (url.username || url.password) {
    throw new Error(t("config.baseUrlHasCredentials"));
  }
  const host = url.hostname.toLowerCase();
  if (host !== ALLOWED_HOST_EXACT && !host.endsWith(ALLOWED_HOST_SUFFIX)) {
    throw new Error(t("config.baseUrlHostNotAllowed", { host }));
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

export function endpointCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.ANTIGRAVITY_BASE_URL?.trim();
  return explicit ? [assertSafeBaseUrl(explicit)] : [...ENDPOINTS];
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return endpointCandidates(env)[0] ?? ENDPOINTS[0];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `positiveInt`, but 0 is a meaningful value (it disables the wait). */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DB_PATH?.trim();
  return value && value.length > 0 ? value : "./data/antigravity.db";
}

export function getPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
}

export function getHost(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.HOST?.trim();
  return value && value.length > 0 ? value : "0.0.0.0";
}

export function getUpstreamTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.UPSTREAM_TIMEOUT_MS, 120_000);
}
export function getStreamHeaderTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.STREAM_HEADER_TIMEOUT_MS, 180_000);
}
export function getStreamStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.STREAM_STALL_TIMEOUT_MS, 120_000);
}
export function getQuotaRefreshTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.QUOTA_REFRESH_TTL_MS, 300_000);
}
export function getModelsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MODELS_TTL_MS, 14_400_000);
}
export function getCooldownTransientMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.COOLDOWN_TRANSIENT_MS, 60_000);
}

/**
 * Wait before retrying the same account after a transient throttle. Kept short:
 * the account is healthy and its quota intact, so the retry is cheap and the
 * alternative — switching accounts or waiting out a cooldown — costs far more.
 */
export function getTransientRetryBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeInt(env.TRANSIENT_RETRY_BACKOFF_MS, 1_000);
}
export function getMaxFailoverAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.MAX_FAILOVER_ATTEMPTS, 3);
}

/** The levels the logger understands. `silent` is one of them, so logging can be muted. */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The level to log at. An unrecognised value falls back to `info` rather than throwing,
 * the way an unknown locale does: a typo in an environment variable must not stop the
 * service from booting, and the fallback is the level this service logged at before the
 * setting existed.
 */
export function getLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const value = env.LOG_LEVEL?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as LogLevel)
    : "info";
}

export function getUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ANTIGRAVITY_USER_AGENT?.trim();
  return value && value.length > 0 ? value : DEFAULT_USER_AGENT;
}

export function getClientCredentials(env: NodeJS.ProcessEnv = process.env): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = env.ANTIGRAVITY_CLIENT_ID?.trim();
  const clientSecret = env.ANTIGRAVITY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(t("config.clientCredentialsMissing"));
  }
  return { clientId, clientSecret };
}

/** Secret redaction: no output, log or response carries a credential. */
export function redact(text: string): string {
  return String(text ?? "")
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/\/?[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email || typeof email !== "string" || !email.includes("@")) return undefined;
  const [name, domain] = email.split("@");
  if (!name || !domain) return "[redacted-email]";
  const masked = name.length > 2 ? `${name[0]}***${name.at(-1)}` : `${name[0]}***`;
  return `${masked}@${domain}`;
}
