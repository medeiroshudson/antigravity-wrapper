import { endpointCandidates, getUpstreamTimeoutMs } from "../../config/index.js";
import type { AccountService } from "../accounts/service.js";
import {
  classifyUpstream,
  ClientDisconnectedError,
  isDefinitive,
  UpstreamError,
} from "../antigravity/errors.js";
import { antigravityHeaders } from "../antigravity/rpc.js";
import { AllAccountsFailedError } from "../chat/turn.js";
import { noopLogger, type Logger } from "../logger.js";
import { buildImageEnvelope, parseAspectRatio } from "./envelope.js";

export { AllAccountsFailedError } from "../chat/turn.js";

export interface GenerateImageResult {
  b64Json: string;
  revisedPrompt: string;
  mimeType?: string;
}

export interface GenerateImageOptions {
  size?: string;
  model?: string;
  n?: number;
  signal?: AbortSignal;
}

export interface ImageServiceDeps {
  accountService: AccountService;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export class ImageService {
  private readonly logger: Logger;

  constructor(private readonly deps: ImageServiceDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  private applyFailure(accountId: string, error: UpstreamError): void {
    const service = this.deps.accountService as unknown as Record<string, unknown>;
    if (typeof service.applyFailure === "function") {
      service.applyFailure(accountId, error);
    } else if (typeof service.markCooldown === "function") {
      service.markCooldown(accountId, error);
    }

    if (error.status === 429 && typeof service.refreshQuota === "function") {
      void (service.refreshQuota as (id: string) => Promise<unknown>)(accountId).catch(() => undefined);
    }
  }

  private markUsed(accountId: string): void {
    const service = this.deps.accountService as unknown as Record<string, unknown>;
    if (typeof service.markUsed === "function") {
      service.markUsed(accountId);
    }
  }

  async generate(prompt: string, options?: GenerateImageOptions): Promise<GenerateImageResult[]> {
    const count = options?.n !== undefined && options.n > 0 ? options.n : 1;
    const results: GenerateImageResult[] = [];

    for (let i = 0; i < count; i++) {
      if (options?.signal?.aborted) {
        throw new ClientDisconnectedError();
      }
      const single = await this.generateSingle(prompt, options);
      results.push(single);
    }

    return results;
  }

  private async generateSingle(prompt: string, options?: GenerateImageOptions): Promise<GenerateImageResult> {
    const candidates = await this.deps.accountService.orderFor("gemini-3.1-flash-image");
    if (!candidates || candidates.length === 0) {
      throw new AllAccountsFailedError([]);
    }

    const { aspectRatio, warning } = parseAspectRatio(options?.size);
    if (warning) {
      this.logger.warn({ warning, size: options?.size }, "image size warning");
    }

    const failures: Array<{ accountId: string; kind: string; message: string; retryAfterMs?: number | null }> = [];

    for (const candidate of candidates) {
      if (options?.signal?.aborted) {
        throw new ClientDisconnectedError();
      }

      try {
        const fresh = await this.deps.accountService.ensureFresh(candidate);
        const projectId = fresh.projectId || "aicode-consumers";
        const envelope = buildImageEnvelope({
          projectId,
          prompt,
          aspectRatio,
        });

        const headers = antigravityHeaders(fresh.accessToken ?? "", { env: this.deps.env });
        const body = JSON.stringify(envelope);

        const result = await this.executeUpstream(candidate.id, headers, body, prompt, options?.signal);
        this.markUsed(candidate.id);
        return result;
      } catch (error) {
        if (error instanceof ClientDisconnectedError) {
          throw error;
        }

        if (error instanceof UpstreamError) {
          if (error.kind === "client_error" && error.message.includes("Safety violation")) {
            throw error;
          }

          this.applyFailure(candidate.id, error);
          failures.push({
            accountId: candidate.id,
            kind: error.kind,
            message: error.message,
            retryAfterMs: error.retryAfterMs,
          });
          continue;
        }

        throw error;
      }
    }

    throw new AllAccountsFailedError(failures);
  }

  private async executeUpstream(
    accountId: string,
    headers: Record<string, string>,
    body: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<GenerateImageResult> {
    const endpoints = endpointCandidates(this.deps.env);
    const timeoutMs = getUpstreamTimeoutMs(this.deps.env);
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    let lastError: UpstreamError | null = null;

    for (const endpoint of endpoints) {
      if (signal?.aborted) throw new ClientDisconnectedError();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}/v1internal:generateContent`, {
          method: "POST",
          headers,
          body,
          signal: combinedSignal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (signal?.aborted) throw new ClientDisconnectedError();
        if (controller.signal.aborted) {
          lastError = new UpstreamError("server_error", 0, "Upstream request timed out");
          continue;
        }
        lastError = new UpstreamError(
          "server_error",
          0,
          err instanceof Error ? err.message : "Transport error",
        );
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const data = (await response.json()) as any;

        const promptBlock =
          data?.response?.promptFeedback?.blockReason ??
          data?.promptFeedback?.blockReason;
        const candidate = data?.response?.candidates?.[0] ?? data?.candidates?.[0];
        const candidateBlock = candidate?.promptFeedback?.blockReason;
        const finishReason = candidate?.finishReason;

        if (promptBlock || candidateBlock || finishReason === "SAFETY") {
          throw new UpstreamError("client_error", 400, "Safety violation");
        }

        const parts = candidate?.content?.parts ?? candidate?.parts ?? [];
        let b64Json: string | undefined;
        let mimeType = "image/jpeg";
        for (const part of parts) {
          if (part?.inlineData?.data) {
            b64Json = part.inlineData.data;
            if (part?.inlineData?.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            break;
          }
        }

        if (!b64Json) {
          throw new UpstreamError("server_error", 500, "No image data returned by upstream");
        }

        const textPart = parts.find((p: any) => typeof p?.text === "string" && p.text.trim().length > 0);
        const revisedPrompt = textPart?.text?.trim() || prompt;

        return { b64Json, revisedPrompt, mimeType };
      }

      const text = await response.text();
      if (/SAFETY|PROHIBITED_CONTENT|blockReason/i.test(text)) {
        throw new UpstreamError("client_error", 400, "Safety violation");
      }

      const error = classifyUpstream(response.status, text);
      lastError = error;

      if (
        response.status === 429 ||
        response.status >= 500 ||
        error.kind === "auth" ||
        error.kind === "validation_required" ||
        isDefinitive(error.kind)
      ) {
        break;
      }
    }

    throw lastError ?? new UpstreamError("server_error", 0, "No endpoint available");
  }
}
