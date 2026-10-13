/**
 * Message catalog for every string the API returns to a caller.
 *
 * One entry per message, keyed by a stable id, so adding a locale is adding one
 * object and a typo in a key is a compile error rather than a missing string at
 * runtime. Locales are complete by type: a catalog cannot omit a key.
 */

export type Locale = "en-US";

export const DEFAULT_LOCALE: Locale = "en-US";

export const LOCALES: readonly Locale[] = ["en-US"];

const enUS = {
  // --- configuration / startup ---------------------------------------------
  "config.apiKeyMissing": "API_KEY must be configured",
  "config.apiKeyInvalid": "API_KEY must be a valid Bearer token without whitespace or commas",
  "config.baseUrlInvalid": "Invalid ANTIGRAVITY_BASE_URL: {value}",
  "config.baseUrlNotHttps": "ANTIGRAVITY_BASE_URL must use https (got {protocol})",
  "config.baseUrlHasCredentials": "ANTIGRAVITY_BASE_URL must not include credentials",
  "config.baseUrlHostNotAllowed":
    'ANTIGRAVITY_BASE_URL host "{host}" is not allowed; use a *.googleapis.com endpoint',
  "config.clientCredentialsMissing":
    "ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET are required: no secret is embedded in the code.",

  // --- account pool --------------------------------------------------------
  "account.notFound": "account not found",
  "account.notFoundAfterUpsert": "account {id} not found after upsert",
  "account.vanishedDuringRefresh": "account {id} vanished during refresh",
  "account.refreshFailed": "failed to renew the access token",
  "account.validationRequired":
    "Account requires browser verification (VALIDATION_REQUIRED); retrying will not help.",
  "account.noEligible":
    "No eligible account in the pool: register or re-enable one under /admin/accounts.",
  "account.allFailed": "All accounts failed: {failures}",

  // --- admin login flow ----------------------------------------------------
  "admin.callbackUrlRequired": "callbackUrl is required",
  "admin.callbackUrlInvalid": "callbackUrl is not a valid URL",
  "admin.callbackUrlMissingParams": "callbackUrl is missing code or state",
  "admin.stateUnknown": "state is unknown or expired; restart the login",

  // --- ingress authentication ----------------------------------------------
  "auth.invalidCredentials": "Invalid authentication credentials",

  // --- chat route ----------------------------------------------------------
  "chat.modelNotFound": "Model '{model}' not found",
  "chat.messagesEmpty": "toContents expects a non-empty list of messages",
  "chat.accountWithoutProjectId": "account has no projectId",
  "chat.streamWithoutFinishReason": "stream ended without finishReason",
  "chat.clientDisconnected": "client disconnected",

  // --- upstream transport --------------------------------------------------
  "upstream.cancelledByClient": "stream request cancelled by the client",
  "upstream.readAborted": "stream read aborted",
  "upstream.noHeaders": "upstream did not send headers within {ms}ms",
  "upstream.stalled": "stream produced no data for {ms}ms",
  "upstream.emptyBody": "response has no body",
  "upstream.noEndpoint": "no endpoint responded",

  // --- OAuth ---------------------------------------------------------------
  "oauth.tokenExchangeFailed": "Token exchange failed ({status}): {detail}",
  "oauth.tokenResponseNotJson": "Token response was not valid JSON: {detail}",
  "oauth.missingAccessToken": "Token response has no access_token",
  "oauth.missingRefreshToken":
    "No refresh_token: sign in again ensuring access_type=offline and prompt=consent",
  "oauth.refreshMissingAccessToken": "Refresh response has no access_token",
  "oauth.loadCodeAssistFailed": "loadCodeAssist responded {status}",
  "oauth.loadCodeAssistNoProject": "loadCodeAssist returned no projectId",
  "oauth.projectIdDiscoveryFailed": "Could not discover the projectId: {detail}",
} as const;

export type MessageKey = keyof typeof enUS;

/** Every key the default catalog defines, for completeness checks. */
export const MESSAGE_KEYS = Object.keys(enUS) as MessageKey[];

const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  "en-US": enUS,
};

export type MessageParams = Record<string, string | number>;

/** Leaves `{param}` in place when the value is absent, so a gap is visible, never silent. */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = params[key];
    return value === undefined ? placeholder : String(value);
  });
}

let activeLocale: Locale = DEFAULT_LOCALE;

/**
 * Reads the configured locale. An unknown or absent value falls back to the
 * default rather than failing: a bad locale must not stop the service.
 */
export function resolveLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const raw = env.APP_LOCALE?.trim();
  if (!raw) return DEFAULT_LOCALE;
  const match = LOCALES.find((locale) => locale.toLowerCase() === raw.toLowerCase());
  return match ?? DEFAULT_LOCALE;
}

export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getLocale(): Locale {
  return activeLocale;
}

export function resetLocaleForTests(): void {
  activeLocale = DEFAULT_LOCALE;
}

/** Renders a catalog entry in the active locale. */
export function t(key: MessageKey, params?: MessageParams): string {
  return interpolate(CATALOGS[activeLocale][key], params);
}
