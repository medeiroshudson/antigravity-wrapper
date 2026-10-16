import {
  endpointCandidates,
  getStreamHeaderTimeoutMs,
  getStreamStallTimeoutMs,
  getUserAgent,
  redact,
} from "../../config/index.js";
import { t } from "../../i18n/index.js";
import { noopLogger, type Logger } from "../logger.js";
import { classifyUpstream, isDefinitive, UpstreamError } from "./errors.js";

export function antigravityHeaders(
  token: string,
  opts: { userAgent?: string | null; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const ua = opts.userAgent === undefined ? getUserAgent(opts.env) : opts.userAgent;
  if (ua !== null) headers["User-Agent"] = ua;
  return headers;
}

/** Errors worth retrying on another endpoint; repeating a 400 is pointless. */
const RETRYABLE_STATUS = new Set([403, 404, 429, 500, 502, 503, 504]);

export async function streamGenerate(
  token: string,
  envelope: unknown,
  deps: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    userAgent?: string | null;
    logger?: Logger;
  } = {},
): Promise<Response> {
  const logger = deps.logger ?? noopLogger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = JSON.stringify(envelope);
  const headerMs = getStreamHeaderTimeoutMs(deps.env);
  let first: UpstreamError | null = null;

  for (const endpoint of endpointCandidates(deps.env)) {
    // Deadline up to the headers, combined with the caller signal (AbortSignal.any).
    // A backend that accepts the connection and never responds would otherwise hang the
    // request until the client disappears or TCP expires: it becomes a classified
    // `server_error`, which triggers the failover of spec §11. The timer is cleared when
    // the headers arrive, so a long stream body is not cut short.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), headerMs);
    const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;

    let response: Response;
    logger.debug({ endpoint }, "upstream attempt");
    try {
      response = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: antigravityHeaders(token, { userAgent: deps.userAgent, env: deps.env }),
        body,
        signal,
      });
    } catch (error) {
      if (deps.signal?.aborted) {
        throw new UpstreamError("client_error", 0, t("upstream.cancelledByClient"));
      }
      if (controller.signal.aborted) {
        logger.warn({ endpoint, ms: headerMs }, "upstream no headers");
        throw new UpstreamError("server_error", 0, t("upstream.noHeaders", { ms: headerMs }));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response;

    const text = await response.text();
    const error = classifyUpstream(response.status, text);
    logger.warn(
      {
        endpoint,
        status: response.status,
        kind: error.kind,
        detail: redact(error.message).slice(0, 200),
        body: redact(text).slice(0, 4000),
      },
      "upstream rejected",
    );
    // The endpoint list is ordered by priority, so the first answer is the authority and a
    // later one only speaks when nothing higher did. Keeping the last error instead let a
    // reserve's 429 overwrite the primary's 404, reporting a missing model as a rate limit
    // (spec §6.1).
    if (first === null) first = error;
    // A definitive failure is not repaired by another channel: stop and report it.
    if (isDefinitive(error.kind) || !RETRYABLE_STATUS.has(response.status)) break;
  }

  const exhausted = first ?? new UpstreamError("server_error", 0, t("upstream.noEndpoint"));
  logger.warn({ status: exhausted.status, kind: exhausted.kind }, "upstream exhausted");
  throw exhausted;
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface StreamCandidate {
  content?: { parts?: Array<Record<string, unknown>> };
  finishReason?: string;
  groundingMetadata?: unknown;
}

export interface StreamChunk {
  response?: { candidates?: StreamCandidate[]; usageMetadata?: UsageMetadata };
}

function parseSseLine(line: string): StreamChunk | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as StreamChunk;
  } catch {
    return null;
  }
}

/**
 * Reads the backend SSE, yielding each parsed `data:`.
 * Partial lines split across network chunks are reassembled in a buffer; the stall
 * watchdog ends with an error instead of hanging when the server goes silent; and
 * `opts.signal` interrupts reading on abort (cancelling the upstream body).
 */
export async function* readSse(
  response: Response,
  opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): AsyncGenerator<StreamChunk> {
  if (!response.body) {
    throw new UpstreamError("server_error", response.status, t("upstream.emptyBody"));
  }
  const logger = opts.logger ?? noopLogger;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const stallMs = getStreamStallTimeoutMs(opts.env);
  const signal = opts.signal;
  let buffer = "";

  // A client abort is not retried: surfaced as a client error.
  let onAbort: (() => void) | null = null;
  const abort = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new UpstreamError("client_error", 0, t("upstream.readAborted")));
          return;
        }
        onAbort = () => reject(new UpstreamError("client_error", 0, t("upstream.readAborted")));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : null;

  try {
    for (;;) {
      const read = reader.read();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const stall =
        stallMs > 0
          ? new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                logger.warn({ ms: stallMs }, "upstream stalled");
                reject(new UpstreamError("server_error", 0, t("upstream.stalled", { ms: stallMs })));
              }, stallMs);
            })
          : null;

      let result: Awaited<typeof read>;
      try {
        const racers: Array<Promise<Awaited<typeof read>>> = [read];
        if (stall) racers.push(stall);
        if (abort) racers.push(abort);
        result = await (racers.length > 1 ? Promise.race(racers) : read);
      } finally {
        // The read may have won the race: the stall timer must not be left alive.
        if (timer !== null) clearTimeout(timer);
      }

      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        const parsed = parseSseLine(line);
        if (parsed) yield parsed;
      }
    }
    const tail = parseSseLine(buffer.replace(/\r$/, ""));
    if (tail) yield tail;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
  }
}
