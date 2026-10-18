import type { FastifyInstance } from "fastify";
import type { AccountStore } from "../lib/accounts/store.js";
import { AccountService } from "../lib/accounts/service.js";
import { getAccountService, getStore } from "../lib/runtime.js";
import { ImageService } from "../lib/images/service.js";
import { ClientDisconnectedError, isPoolRateLimited, UpstreamError } from "../lib/antigravity/errors.js";
import { AllAccountsFailedError } from "../lib/chat/turn.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";
import { wireClientDisconnect } from "./chat.js";

export const VALID_IMAGE_MODELS = new Set(["gemini-3.1-flash-image"]);
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";

export interface ImagesRouteDeps {
  store?: AccountStore;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  accountService?: AccountService;
  imageService?: ImageService;
}

interface ImageGenerationBody {
  prompt?: unknown;
  model?: unknown;
  n?: unknown;
  size?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

export async function imagesRoutes(
  app: FastifyInstance,
  deps: ImagesRouteDeps = {},
): Promise<void> {
  app.post("/v1/images/generations", async (request, reply) => {
    const body = request.body as ImageGenerationBody | undefined;
    const log = request.log;
    const requestStart = Date.now();

    if (!body || typeof body !== "object") {
      const mapped = toOpenAIErrorBody(new Error("prompt is required"), 400);
      reply.status(400).send(mapped.body);
      return;
    }

    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      const mapped = toOpenAIErrorBody(
        new Error("prompt is required and must be a non-empty string"),
        400,
      );
      reply.status(400).send(mapped.body);
      return;
    }

    if (body.prompt.length > 4000) {
      const mapped = toOpenAIErrorBody(
        new Error("prompt exceeds maximum length of 4000 characters"),
        400,
      );
      reply.status(400).send(mapped.body);
      return;
    }

    const model = body.model === undefined || body.model === null ? DEFAULT_IMAGE_MODEL : body.model;
    if (typeof model !== "string" || !VALID_IMAGE_MODELS.has(model)) {
      const mapped = toOpenAIErrorBody(
        new Error(`Model '${String(body.model)}' is not supported. Supported models: ${[...VALID_IMAGE_MODELS].join(", ")}`),
        400,
      );
      reply.status(400).send(mapped.body);
      return;
    }

    if (body.n !== undefined && body.n !== null) {
      if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 1 || body.n > 4) {
        const mapped = toOpenAIErrorBody(
          new Error("n must be an integer between 1 and 4"),
          400,
        );
        reply.status(400).send(mapped.body);
        return;
      }
    }
    const n = (body.n as number | undefined) ?? 1;

    const responseFormat =
      body.response_format === undefined || body.response_format === null ? "b64_json" : body.response_format;
    if (responseFormat !== "b64_json" && responseFormat !== "url") {
      const mapped = toOpenAIErrorBody(
        new Error("response_format must be 'b64_json' or 'url'"),
        400,
      );
      reply.status(400).send(mapped.body);
      return;
    }

    if (body.size !== undefined && body.size !== null && typeof body.size !== "string") {
      const mapped = toOpenAIErrorBody(
        new Error("size must be a string"),
        400,
      );
      reply.status(400).send(mapped.body);
      return;
    }
    const size = body.size as string | undefined;

    const accounts =
      deps.accountService ??
      (deps.store
        ? new AccountService({ store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl, logger: log })
        : deps.fetchImpl
          ? new AccountService({ store: getStore(deps.env), env: deps.env, fetchImpl: deps.fetchImpl, logger: log })
          : getAccountService(deps.env, log));

    const imageService =
      deps.imageService ??
      new ImageService({
        accountService: accounts,
        fetchImpl: deps.fetchImpl,
        env: deps.env,
        logger: log,
      });

    const controller = new AbortController();
    wireClientDisconnect(reply.raw, controller);

    try {
      const results = await imageService.generate(body.prompt, {
        model,
        n,
        size,
        signal: controller.signal,
      });

      const created = Math.floor(Date.now() / 1000);
      const data = results.map((item) =>
        responseFormat === "url"
          ? {
              url: `data:${item.mimeType || "image/jpeg"};base64,${item.b64Json}`,
              revised_prompt: item.revisedPrompt,
            }
          : {
              b64_json: item.b64Json,
              revised_prompt: item.revisedPrompt,
            },
      );

      log.info(
        {
          model,
          n,
          responseFormat,
          count: results.length,
          elapsedMs: Date.now() - requestStart,
        },
        "image generation completed",
      );

      reply.status(200).send({
        created,
        data,
      });
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        log.info(
          {
            model,
            elapsedMs: Date.now() - requestStart,
          },
          "client disconnected",
        );
        return;
      }

      if (error instanceof UpstreamError) {
        const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
        const mapped = toOpenAIErrorBody(error, status);
        if (mapped.status === 400 && error.message.toLowerCase().includes("safety")) {
          mapped.body.error.code = "content_policy_violation";
        }
        log.warn(
          {
            model,
            status: mapped.status,
            kind: error.kind,
            detail: error.message,
            elapsedMs: Date.now() - requestStart,
          },
          "image generation upstream error",
        );
        reply.status(mapped.status).send(mapped.body);
        return;
      }

      if (error instanceof AllAccountsFailedError) {
        const status = isPoolRateLimited(error.failures) || error.failures.length === 0 ? 429 : 503;
        const mapped = toOpenAIErrorBody(error, status);
        log.warn(
          {
            model,
            status: mapped.status,
            failures: error.failures.length,
            elapsedMs: Date.now() - requestStart,
          },
          "all accounts failed for image generation",
        );
        reply.status(mapped.status).send(mapped.body);
        return;
      }

      const mapped = toOpenAIErrorBody(error, 500);
      log.warn(
        {
          model,
          status: mapped.status,
          err: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - requestStart,
        },
        "image generation unexpected error",
      );
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
