import { timingSafeEqual } from "node:crypto";
import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { getBodyLimitBytes, getHost, getLogLevel, getPort, resolveApiKey } from "./config/index.js";
import { resolveLocale, setLocale, t } from "./i18n/index.js";
import type { AccountService } from "./lib/accounts/service.js";
import type { AccountStore } from "./lib/accounts/store.js";
import type { ImageService } from "./lib/images/service.js";
import { toOpenAIErrorBody } from "./lib/openai-format/index.js";
import { startCatalogRefresh } from "./lib/runtime.js";
import { accountsRoutes } from "./routes/accounts.js";
import { chatRoutes } from "./routes/chat.js";
import { imagesRoutes } from "./routes/images.js";
import { modelsRoutes } from "./routes/models.js";

export interface BuildServerDeps {
  store?: AccountStore;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Injectable so tests can silence the request log. Default: true. */
  logger?: FastifyServerOptions["logger"];
  accountService?: AccountService;
  imageService?: ImageService;
}

function readStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}

export function buildServer(
  apiKey?: string,
  deps: BuildServerDeps = {},
): FastifyInstance {
  // Key precedence: explicit parameter > deps.env.API_KEY (documented seam)
  // > process.env.API_KEY (keeps the `buildServer()` entrypoint reading the environment).
  // Absent from all three sources it falls back to "" and resolveApiKey fails closed.
  const envKey = deps.env?.API_KEY ?? process.env.API_KEY ?? "";
  // The server owns its message locale: resolved once here from the same env the
  // rest of the configuration comes from, so an injected env is honoured too.
  setLocale(resolveLocale({ ...process.env, ...(deps.env ?? {}) }));
  const expected = resolveApiKey({
    ...process.env,
    ...(deps.env ?? {}),
    API_KEY: apiKey ?? envKey,
  });
  const app = Fastify({
    logger: deps.logger ?? { level: getLogLevel({ ...process.env, ...(deps.env ?? {}) }) },
    bodyLimit: getBodyLimitBytes({ ...process.env, ...(deps.env ?? {}) }),
  });

  // Reverse proxies (e.g. Cloudflare Tunnel, Traefik over HTTP/2) forward bodyless
  // POST requests with `Transfer-Encoding: chunked`. Fastify's default behavior treats
  // any non-empty body indicator without a Content-Type header as 415 Unsupported Media Type.
  // A catch-all parser consumes empty/untyped payloads without rejecting bodyless calls.
  app.addContentTypeParser("*", (_request, payload, done) => {
    let data = "";
    payload.on("data", (chunk: Buffer) => {
      data += chunk;
    });
    payload.on("end", () => {
      if (!data || data.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(data));
      } catch {
        done(null, data);
      }
    });
  });

  // Bearer required on EVERY route, including /health and /admin.
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s,]+)$/i.exec(header) : null;
    const provided = Buffer.from(match?.[1] ?? "");
    const wanted = Buffer.from(expected);
    const valid = provided.length === wanted.length && timingSafeEqual(provided, wanted);
    if (!valid) {
      request.log.warn(
        { url: request.url, method: request.method, remoteAddress: request.ip },
        "request unauthorized",
      );
      reply.status(401).send({
        error: {
          message: t("auth.invalidCredentials"),
          type: "server_error",
          code: "antigravity_error",
          param: null,
        },
      });
    }
  });

  app.register(modelsRoutes);
  app.register(chatRoutes, deps);
  app.register(accountsRoutes, deps);
  app.register(imagesRoutes, deps);

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error: unknown, request, reply) => {
    const status = readStatus(error) === 400 ? 400 : 500;
    const mapped = toOpenAIErrorBody(error, status);
    // Fastify's own failures — most importantly the 413 it raises when a body
    // exceeds `bodyLimit` — reach here with no other log line naming the reason.
    request.log.warn(
      {
        status: mapped.status,
        code: typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined,
        err: error instanceof Error ? error.message : String(error),
      },
      "request failed",
    );
    reply.status(mapped.status).send(mapped.body);
  });

  return app;
}

const entry = process.argv[1];
const isMain = typeof entry === "string" && (entry.endsWith("server.js") || entry.endsWith("server.ts"));

if (isMain) {
  loadEnv();
  const app = buildServer();
  // Catalog/quota discovery only here, never in buildServer: tests neither open
  // the real database nor touch the network.
  const catalog = startCatalogRefresh(process.env, { logger: app.log });
  app.log.info(
    { port: getPort(), host: getHost(), logLevel: getLogLevel(process.env), bodyLimitBytes: getBodyLimitBytes(process.env) },
    "server starting",
  );
  app.listen({ port: getPort(), host: getHost() }).catch((error: unknown) => {
    app.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    catalog.stop();
    app.log.info(`received ${signal}, shutting down`);
    setTimeout(() => process.exit(0), 10_000);
    app.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
