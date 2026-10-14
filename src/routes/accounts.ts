import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getClientCredentials, maskEmail } from "../config/index.js";
import { t } from "../i18n/index.js";
import { AccountService } from "../lib/accounts/service.js";
import {
  buildAuthUrl,
  discoverProjectId,
  exchangeCode,
  generatePkce,
  getUserEmail,
} from "../lib/antigravity/oauth.js";
import { toIsoUtc, toResetPhrase } from "../lib/format/datetime.js";
import { toGroupsView } from "../lib/format/quota.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";
import { getAccountService, getStore } from "../lib/runtime.js";
import type { Account, AccountStore } from "../lib/accounts/store.js";

interface RouteDeps {
  env?: NodeJS.ProcessEnv;
  store?: AccountStore;
  fetchImpl?: typeof fetch;
}

/**
 * Public view: never includes refresh_token or access_token. Every date is ISO 8601 UTC,
 * the cooldown comes with its time remaining so a reader does not have to subtract
 * epochs, and the tier comes as an object whose `id` a caller can branch on (spec §10,
 * D15).
 */
function publicView(
  account: Account | undefined,
  now: number = Date.now(),
): Record<string, unknown> | null {
  if (!account) return null;
  return {
    id: account.id,
    email: maskEmail(account.email ?? undefined) ?? null,
    projectId: account.projectId,
    status: account.status,
    // Both halves, or null when the tier was never read. An object absent entirely
    // would be indistinguishable from an account whose tier is unknown.
    paidTier:
      account.paidTierId === null && account.paidTierName === null
        ? null
        : { id: account.paidTierId, name: account.paidTierName },
    cooldownUntil: toIsoUtc(account.cooldownUntil),
    cooldownResetsIn: toResetPhrase(account.cooldownUntil, now),
    lastError: account.lastError,
    enabled: account.enabled,
    priority: account.priority,
    createdAt: toIsoUtc(account.createdAt),
    lastUsedAt: toIsoUtc(account.lastUsedAt),
  };
}

export async function accountsRoutes(app: FastifyInstance, deps: RouteDeps = {}): Promise<void> {
  const store = deps.store ?? getStore(deps.env);

  // The injected store (buildServer) must win: the runtime.ts singletons exist
  // for the production entrypoint, not for the route under test. Resolving the
  // service on demand avoids opening the real database when merely registering
  // the routes.
  const resolveService = (): AccountService =>
    deps.store
      ? new AccountService({ store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl })
      : getAccountService(deps.env);

  const notFound = (reply: FastifyReply): FastifyReply => {
    const mapped = toOpenAIErrorBody(new Error(t("account.notFound")), 404);
    return reply.status(mapped.status).send(mapped.body);
  };

  app.post("/admin/accounts/start", async (_request, reply) => {
    try {
      const { clientId } = getClientCredentials(deps.env);
      const { verifier, challenge } = generatePkce();
      // State independent of the verifier: a leaked callback does not reveal the code_verifier.
      const state = randomBytes(32).toString("base64url");
      store.savePendingOAuth(state, verifier);
      reply.status(200).send({ authUrl: buildAuthUrl(clientId, state, challenge), state });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 500);
      reply.status(mapped.status).send(mapped.body);
    }
  });

  app.post<{ Body: { callbackUrl?: string } }>("/admin/accounts/complete", async (request, reply) => {
    const raw = request.body?.callbackUrl?.trim();
    if (!raw) {
      const mapped = toOpenAIErrorBody(new Error(t("admin.callbackUrlRequired")), 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    let code: string | null = null;
    let state: string | null = null;
    try {
      const url = new URL(raw);
      code = url.searchParams.get("code");
      state = url.searchParams.get("state");
    } catch {
      const mapped = toOpenAIErrorBody(new Error(t("admin.callbackUrlInvalid")), 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    if (!code || !state) {
      const mapped = toOpenAIErrorBody(new Error(t("admin.callbackUrlMissingParams")), 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    const pending = store.takePendingOAuth(state);
    if (!pending) {
      const mapped = toOpenAIErrorBody(new Error(t("admin.stateUnknown")), 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    try {
      const tokens = await exchangeCode({
        code,
        verifier: pending.verifier,
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      const project = await discoverProjectId(tokens.accessToken, {
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      // Best-effort: without an email the account stays usable (the id serves as the label).
      const email = await getUserEmail(tokens.accessToken, {
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      const account = store.upsertAccount({
        id: `account-${randomBytes(8).toString("hex")}`,
        email: email ?? null,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        projectId: project.projectId,
      });
      // Login already has the tier in hand, so the first admin view is populated
      // without waiting for the refresh cycle (spec D14).
      store.setPaidTier(account.id, { id: project.paidTierId, name: project.paidTier });
      // No top-level paidTier: the account object carries it as { id, name } (spec §9.1).
      reply.status(200).send({ account: publicView(store.getAccount(account.id)) });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 400);
      reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get("/admin/accounts", async (_request, reply) => {
    reply.status(200).send({ accounts: store.listAccounts().map((account) => publicView(account)) });
  });

  app.get("/admin/accounts/quota", async (_request, reply) => {
    const now = Date.now();
    reply.status(200).send({
      generatedAt: toIsoUtc(now),
      accounts: store.snapshot().map((account) => ({
        ...publicView(account, now),
        groups: toGroupsView(account.quota, now),
        quotaSummaryError: account.quotaSummaryError,
      })),
    });
  });

  app.get<{ Params: { id: string } }>("/admin/accounts/:id", async (request, reply) => {
    const account = store.getAccount(request.params.id);
    if (!account) return notFound(reply);
    const now = Date.now();
    reply.status(200).send({
      account: publicView(account, now),
      groups: toGroupsView(store.getQuota(account.id), now),
    });
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; priority?: number } }>(
    "/admin/accounts/:id",
    async (request, reply) => {
      const account = store.getAccount(request.params.id);
      if (!account) return notFound(reply);
      if (typeof request.body?.enabled === "boolean") store.setEnabled(account.id, request.body.enabled);
      if (typeof request.body?.priority === "number") store.setPriority(account.id, request.body.priority);
      reply.status(200).send({ account: publicView(store.getAccount(account.id)) });
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/accounts/:id", async (request, reply) => {
    if (!store.getAccount(request.params.id)) return notFound(reply);
    store.removeAccount(request.params.id);
    reply.status(200).send({ removed: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/admin/accounts/:id/refresh", async (request, reply) => {
    if (!store.getAccount(request.params.id)) return notFound(reply);
    try {
      await resolveService().refreshQuota(request.params.id);
      reply.status(200).send({ account: publicView(store.getAccount(request.params.id)) });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 502);
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
