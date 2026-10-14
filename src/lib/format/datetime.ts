/**
 * Formats instants for the API. Every date the admin surface returns goes through
 * `toIsoUtc`: one format for the whole surface beats one that needs a decoder ring
 * per field (spec §10).
 */

/**
 * ISO 8601 in UTC with a `Z` offset, at second precision, or `null` when there is
 * no usable instant. Sub-second precision is dropped on purpose: the backend's own
 * `resetTime` carries none, so a round trip through epoch reproduces it exactly.
 */
export function toIsoUtc(epochMs: number | null | undefined): string | null {
  if (epochMs === null || epochMs === undefined) return null;
  if (!Number.isFinite(epochMs)) return null;
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The app's compact time-remaining form: "5d 21h", "4h 9m", "45m", "now".
 *
 * This is a snapshot, not a fact: it is true only at the moment of the response.
 * `resetAt` is the authoritative field; a client that stores the JSON and renders
 * it later shows a stale value (spec §10).
 */
export function toResetPhrase(
  epochMs: number | null | undefined,
  now: number = Date.now(),
): string | null {
  if (epochMs === null || epochMs === undefined) return null;
  if (!Number.isFinite(epochMs)) return null;

  const remainingMs = epochMs - now;
  if (remainingMs < 60_000) return "now";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ${totalHours % 24}h`;
}
