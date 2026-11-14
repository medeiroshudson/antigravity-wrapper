import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getClientCredentials } from "../config/index.js";
import { t } from "../i18n/index.js";
import { AccountService } from "../lib/accounts/service.js";
import { probeAccount } from "../lib/accounts/probe.js";
import { UpstreamError } from "../lib/antigravity/errors.js";
import {
  buildAuthUrl,
  exchangeCode,
  generatePkce,
  getUserEmail,
  type OnboardingOutcome,
} from "../lib/antigravity/oauth.js";
import { toIsoUtc, toResetPhrase } from "../lib/format/datetime.js";
import { toGroupsView, toLeanPoolQuota } from "../lib/format/quota.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";
import { getAccountService, getStore } from "../lib/runtime.js";
import { accountState, isUsable, type Account, type AccountStore } from "../lib/accounts/store.js";

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
    email: account.email ?? null,
    projectId: account.projectId,
    status: account.status,
    // `status` alone never answers "why is this account not serving"; state derives it
    // from status + enabled + the cooldown, and statusKind names the cause.
    state: accountState(account, now),
    usable: isUsable(account, now),
    statusKind: account.statusKind,
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

/**
 * The onboarding result as the admin surface reports it: the outcome the service recorded
 * is the same fact the endpoint answers, so the two cannot disagree (spec D6).
 */
function onboardingView(outcome: OnboardingOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "active":
      return {
        status: outcome.status,
        projectId: outcome.projectId,
        paidTier: { id: outcome.paidTierId, name: outcome.paidTierName },
      };
    case "validation_required":
      return {
        status: outcome.status,
        validationUrl: outcome.validationUrl,
        reason: outcome.reason,
      };
    default:
      return { status: outcome.status, code: outcome.code };
  }
}

/**
 * The two failure sentences `discoverProjectId` used to throw, kept verbatim so the
 * message an operator sees does not depend on which endpoint reported the failure.
 */
function onboardingFailureMessage(code: "no_endpoint" | "no_project"): string {
  return code === "no_endpoint"
    ? t("oauth.projectIdDiscoveryFailed", { detail: t("upstream.noEndpoint") })
    : t("oauth.loadCodeAssistNoProject");
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
      // Best-effort: without an email the account stays usable (the id serves as the label).
      const email = await getUserEmail(tokens.accessToken, {
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      // Persisted before provisioning: login registers the account, onboarding provision
      // it. A second phase Google demands later must find the account here, not as a
      // thrown-away consent the operator has to redo (spec D6).
      const account = store.upsertAccount({
        id: `account-${randomBytes(8).toString("hex")}`,
        email: email ?? null,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        projectId: null,
      });
      // `onboard` applies every store effect itself (project, tier, status, catalog), so
      // the reply only has to report the outcome it recorded. A null outcome means the
      // account vanished between the upsert and the call, which the store treats as fatal.
      const outcome = await resolveService().onboard(account.id);
      if (!outcome) throw new Error(t("account.notFoundAfterUpsert", { id: account.id }));

      if (outcome.status === "validation_required") {
        // 202: the login is accepted and registered, the verification is still owed.
        reply
          .header("Location", `/admin/accounts/${account.id}/onboard`)
          .status(202)
          .send({
            account: publicView(store.getAccount(account.id)),
            onboarding: onboardingView(outcome),
          });
        return;
      }

      if (outcome.status === "failed") {
        const mapped = toOpenAIErrorBody(new Error(onboardingFailureMessage(outcome.code)), 400);
        reply.status(mapped.status).send(mapped.body);
        return;
      }

      // No top-level paidTier: the account object carries it as { id, name } (spec §9.1).
      reply.status(200).send({ account: publicView(store.getAccount(account.id)) });
    } catch (error) {
      // A dead refresh token is the one failure that escapes `onboard` (it records every
      // onboarding outcome itself); the caller cannot fix it by editing the request.
      const mapped =
        error instanceof UpstreamError && error.kind === "auth"
          ? toOpenAIErrorBody(new Error(error.message), 502)
          : toOpenAIErrorBody(error, 400);
      reply.status(mapped.status).send(mapped.body);
    }
  });

  /**
   * Resumes provisioning for an account that is registered but has no project yet (spec D6).
   *
   * Idempotent: a repeat answers the state the previous call left, so an operator who
   * reloads the page, or a client that retried, needs no other endpoint. The service
   * records the outcome as the account's state, which is why a failed outcome is a 502
   * here: the wrapper could not reach Google, the request itself was fine.
   */
  app.post<{ Params: { id: string } }>("/admin/accounts/:id/onboard", async (request, reply) => {
    const account = store.getAccount(request.params.id);
    if (!account) return notFound(reply);

    try {
      const outcome = await resolveService().onboard(account.id);
      if (!outcome) return notFound(reply);

      if (outcome.status === "failed") {
        const mapped = toOpenAIErrorBody(new Error(onboardingFailureMessage(outcome.code)), 502);
        reply.status(mapped.status).send({
          ...mapped.body,
          account: publicView(store.getAccount(account.id)),
          onboarding: onboardingView(outcome),
        });
        return;
      }

      reply.status(200).send({
        account: publicView(store.getAccount(account.id)),
        onboarding: onboardingView(outcome),
      });
    } catch (error) {
      // A dead refresh token escapes `onboard`; nothing about the request is wrong, so it
      // is a bad gateway rather than a bad request.
      const mapped = toOpenAIErrorBody(
        new Error(error instanceof Error ? error.message : String(error)),
        502,
      );
      reply.status(mapped.status).send({
        ...mapped.body,
        account: publicView(store.getAccount(account.id)),
      });
    }
  });

  app.get("/admin/accounts", async (_request, reply) => {
    reply.status(200).send({ accounts: store.listAccounts().map((account) => publicView(account)) });
  });

  app.get<{ Querystring: { detailed?: string } }>("/accounts/quota", async (request, reply) => {
    const now = Date.now();
    const snapshots = store.snapshot();
    const lean = toLeanPoolQuota(snapshots, now);

    if (request.query?.detailed === "true") {
      reply.status(200).send({
        ...lean,
        accounts: snapshots.map((account) => ({
          ...publicView(account, now),
          groups: toGroupsView(account.quota, now),
          quotaSummaryError: account.quotaSummaryError,
        })),
      });
      return;
    }

    reply.status(200).send(lean);
  });

  app.get<{ Querystring: { detailed?: string } }>("/admin/accounts/quota", async (_request, reply) => {
    const now = Date.now();
    const snapshots = store.snapshot();
    const lean = toLeanPoolQuota(snapshots, now);

    reply.status(200).send({
      ...lean,
      accounts: snapshots.map((account) => ({
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

  /**
   * Asks the upstream whether it still refuses the account, and applies the verdict.
   *
   * A reinstated account is invisible otherwise: it is excluded from the selector while
   * `invalid`, the quota refresh keeps succeeding for a blocked account, and `countTokens`
   * does not cross the ToS gate. This is the only path back that costs one request.
   */
  app.post<{ Params: { id: string } }>("/admin/accounts/:id/recheck", async (request, reply) => {
    const account = store.getAccount(request.params.id);
    if (!account) return notFound(reply);

    const service = resolveService();
    try {
      const probe = await probeAccount(
        {
          ensureFresh: (candidate) => service.ensureFresh(candidate),
          env: deps.env,
          fetchImpl: deps.fetchImpl,
        },
        account,
      );

      if (probe.ok) {
        store.setStatus(account.id, "active", { statusKind: null });
        // A reinstated account is one the operator parked *because* of the block: a
        // disabled account makes no request, so it cannot have gained the block while
        // parked. Leaving it disabled reported "liberada" while routing nothing to it.
        store.setEnabled(account.id, true);
      } else if (probe.kind !== null) {
        service.applyFailure(
          account.id,
          new UpstreamError(probe.kind, probe.status, probe.message ?? "", null, probe.appealUrl),
        );
      }

      reply.status(200).send({
        account: publicView(store.getAccount(account.id)),
        probe,
      });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 502);
      reply.status(mapped.status).send(mapped.body);
    }
  });

  app.post<{ Params: { id: string } }>("/admin/accounts/:id/refresh", async (request, reply) => {
    const account = store.getAccount(request.params.id);
    if (!account) return notFound(reply);
    // Provisioning owns the account until Google assigns a project, and the service would
    // no-op silently: point at the route that finishes the job instead of reporting a
    // refresh that read nothing. 400 rather than 409 because only 400/422/404/429 get a
    // caller-facing `type` from `toOpenAIErrorBody`; a 409 would ship as `server_error`.
    if (!account.projectId) {
      const mapped = toOpenAIErrorBody(new Error(t("account.notOnboarded", { id: account.id })), 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }
    try {
      await resolveService().refreshQuota(request.params.id);
      reply.status(200).send({ account: publicView(store.getAccount(request.params.id)) });
    } catch (error) {
      const mapped = toOpenAIErrorBody(error, 502);
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
