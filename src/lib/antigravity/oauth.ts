import { createHash, randomBytes } from "node:crypto";
import {
  endpointCandidates,
  getClientCredentials,
  getUpstreamTimeoutMs,
  getUserAgent,
  redact,
} from "../../config/index.js";
import { t } from "../../i18n/index.js";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

export const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(clientId: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  env?: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(getUpstreamTimeoutMs(env)),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(t("oauth.tokenExchangeFailed", { status: response.status, detail: redact(text).slice(0, 300) }));
  }
  // A 2xx that is not JSON also needs redaction: the JSON.parse error would echo
  // provider bytes without going through `redact`.
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(t("oauth.tokenResponseNotJson", { detail: redact(text).slice(0, 300) }));
  }
}

export async function exchangeCode(input: {
  code: string;
  verifier: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = getClientCredentials(input.env);
  const data = await postToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: input.verifier,
    },
    input.fetchImpl ?? fetch,
    input.env,
  );
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(t("oauth.missingAccessToken"));
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error(t("oauth.missingRefreshToken"));
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS };
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = getClientCredentials(input.env);
  const data = await postToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    },
    input.fetchImpl ?? fetch,
    input.env,
  );
  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(t("oauth.refreshMissingAccessToken"));
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS };
}

function extractProjectId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of [
    "antigravityProjectId",
    "projectId",
    "backendProjectId",
    "userDefinedCloudaicompanionProject",
    "cloudaicompanionProject",
    "project",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      return (value as { id: string }).id;
    }
  }
  return undefined;
}

export async function discoverProjectId(
  accessToken: string,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ projectId: string; paidTier: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getUserAgent(deps.env),
  };

  let lastError = t("upstream.noEndpoint");
  for (const endpoint of endpointCandidates(deps.env)) {
    try {
      const response = await fetchImpl(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        signal: AbortSignal.timeout(getUpstreamTimeoutMs(deps.env)),
      });
      if (!response.ok) {
        lastError = t("oauth.loadCodeAssistFailed", { status: response.status });
        continue;
      }
      const data = (await response.json()) as Record<string, unknown>;
      const projectId = extractProjectId(data);
      if (!projectId) {
        lastError = t("oauth.loadCodeAssistNoProject");
        continue;
      }
      const paid = data.paidTier as { name?: unknown } | undefined;
      return { projectId, paidTier: typeof paid?.name === "string" ? paid.name : null };
    } catch (error) {
      lastError = redact(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(t("oauth.projectIdDiscoveryFailed", { detail: lastError }));
}

/**
 * Best-effort: an account without an email is still usable, so any failure
 * (network, non-ok status, body without `email`) returns `undefined` instead of
 * throwing. No error text is propagated — nothing from upstream leaks into the response.
 */
export async function getUserEmail(
  accessToken: string,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<string | undefined> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": getUserAgent(deps.env),
      },
      signal: AbortSignal.timeout(getUpstreamTimeoutMs(deps.env)),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as Record<string, unknown>;
    const email = data.email;
    return typeof email === "string" && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}
