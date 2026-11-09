import { randomUUID } from "node:crypto";
import { getModelEnum } from "../../config/models.js";
import { UpstreamError, type UpstreamFailureKind } from "../antigravity/errors.js";
import { buildEnvelope, newRequestIdentity, randomInt64 } from "../antigravity/envelope.js";
import { streamGenerate } from "../antigravity/rpc.js";
import type { Logger } from "../logger.js";
import type { Account } from "./store.js";

/**
 * The model a probe asks for. Measured 2026-11-09: this is what the client config reports as
 * `defaultAgentModelId`, so it is the model an account is expected to serve.
 */
export const PROBE_MODEL = "gemini-3.8-flash-high";

/** The smallest request that crosses the ToS gate: one token of output. */
const PROBE_MAX_OUTPUT_TOKENS = 1;

export interface ProbeResult {
  ok: boolean;
  status: number;
  kind: UpstreamFailureKind | null;
  message: string | null;
  appealUrl: string | null;
}

export interface ProbeDeps {
  ensureFresh(account: Account): Promise<Account>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Asks the upstream whether it still refuses this account, with a real generation.
 *
 * `countTokens` is not usable as a probe: measured against a blocked account it answers 200
 * while `generateContent` answers 403 TOS_VIOLATION — the block sits on generation only.
 * The quota refresh is equally blind (banned accounts kept refreshing successfully for
 * days), which is why a reinstated account cannot be noticed any other way.
 *
 * Never throws for an upstream verdict: the verdict *is* the answer.
 */
export async function probeAccount(deps: ProbeDeps, account: Account): Promise<ProbeResult> {
  try {
    const fresh = await deps.ensureFresh(account);
    if (!fresh.projectId) {
      return { ok: false, status: 0, kind: "server_error", message: "account has no projectId", appealUrl: null };
    }

    const identity = newRequestIdentity(
      PROBE_MODEL,
      {
        cascadeId: randomUUID(),
        trajectoryId: randomUUID(),
        sessionId: randomInt64(),
        step: 1,
        requestIndex: 0,
        lastExecutionId: null,
      },
      getModelEnum(PROBE_MODEL),
    );
    const envelope = buildEnvelope({
      projectId: fresh.projectId,
      runtimeModel: PROBE_MODEL,
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      systemInstruction: "probe",
      thinking: { includeThoughts: false },
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      sessionId: identity.sessionId,
      labels: identity.labels,
      requestId: identity.requestId,
    });

    const response = await streamGenerate(fresh.accessToken ?? "", envelope, {
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
    });
    // The verdict is the status itself; the body is irrelevant to the probe.
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, status: response.status, kind: null, message: null, appealUrl: null };
  } catch (error) {
    if (error instanceof UpstreamError) {
      return {
        ok: false,
        status: error.status,
        kind: error.kind,
        message: error.message,
        appealUrl: error.appealUrl,
      };
    }
    throw error;
  }
}
