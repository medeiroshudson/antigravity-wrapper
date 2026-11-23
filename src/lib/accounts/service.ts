import { getLoadBalanceStrategy } from "../../config/index.js";
import { applyCatalog } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import {
  loadCodeAssistInfo,
  onboardAccount,
  refreshAccessToken,
  TokenRequestError,
  TokenResponseError,
  type OnboardingOutcome,
} from "../antigravity/oauth.js";
import {
  fetchAvailableModels,
  fetchAvailableModelsWithQuota,
} from "../antigravity/quota.js";
import { createQuotaStrategy } from "../antigravity/quota-strategies/registry.js";
import type { QuotaFetchStrategy } from "../antigravity/quota-strategies/types.js";
import { UpstreamError } from "../antigravity/errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { cooldownDuration, cooldownPolicy } from "./cooldown-policy.js";
import { familyBucketPrefix, orderDecision } from "./selector.js";
import { createStrategy } from "./strategies/registry.js";
import type { LoadBalanceStrategy } from "./strategies/types.js";
import type { Account, AccountSnapshot, AccountStore } from "./store.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class AccountService {
  private readonly logger: Logger;
  private readonly strategy: LoadBalanceStrategy;
  private readonly quotaStrategy: QuotaFetchStrategy;
  /** Accounts serving a request right now, so a strategy can prefer the idle ones. */
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: AccountStore;
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      now?: () => number;
      logger?: Logger;
      quotaStrategy?: QuotaFetchStrategy;
    },
  ) {
    this.logger = deps.logger ?? noopLogger;
    this.strategy = createStrategy(getLoadBalanceStrategy(deps.env));
    this.quotaStrategy = deps.quotaStrategy ?? createQuotaStrategy("auto");
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async ensureFresh(account: Account): Promise<Account> {
    if (account.accessToken && account.accessExpiresAt > this.now() + REFRESH_SKEW_MS) return account;

    let refreshed: { accessToken: string; expiresAt: number };
    try {
      refreshed = await refreshAccessToken({
        refreshToken: account.refreshToken,
        env: this.deps.env,
        fetchImpl: this.deps.fetchImpl,
      });
    } catch (error) {
      this.logger.warn({ accountId: account.id }, "token refresh failed");
      // A revoked grant is a classified authentication failure: the runner marks the
      // account `invalid` and moves on to the next candidate (spec §11) instead of
      // aborting the whole request. Anything else — a timeout, a `5xx`, a rate limit on
      // the token endpoint — is an outage, not this account's verdict: marking it `auth`
      // parked working accounts over a Google blip.
      // 403 is Google refusing the grant for a disabled or deleted user: still this
      // credential, not the endpoint.
      const revoked =
        error instanceof TokenResponseError ||
        (error instanceof TokenRequestError &&
          (error.status === 400 || error.status === 401 || error.status === 403));
      throw new UpstreamError(
        revoked ? "auth" : "server_error",
        revoked ? 401 : 502,
        error instanceof Error ? error.message : t("account.refreshFailed"),
      );
    }
    this.logger.debug({ accountId: account.id }, "token refreshed");
    this.deps.store.setTokens(account.id, {
      accessToken: refreshed.accessToken,
      accessExpiresAt: refreshed.expiresAt,
    });
    const updated = this.deps.store.getAccount(account.id);
    if (!updated) throw new Error(t("account.vanishedDuringRefresh", { id: account.id }));
    return updated;
  }

  /**
   * Resumes onboarding for an account that is registered but not provisioned (spec D6).
   *
   * Login used to throw when Google had not assigned a project yet, leaving the operator
   * to delete and re-add the account. Here the outcome is written as the account's state,
   * so the pool's view and the endpoint's reply cannot disagree, and a `validation_required`
   * reply hands back the link that finishes the job.
   */
  async onboard(id: string): Promise<OnboardingOutcome | null> {
    const account = this.deps.store.getAccount(id);
    if (!account) return null;
    const fresh = await this.ensureFresh(account);
    const accessToken = fresh.accessToken ?? "";
    const outcome = await onboardAccount(accessToken, {
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
      userEmail: fresh.email ?? undefined,
    });

    if (outcome.status === "active") {
      this.deps.store.markOnboarded(id, {
        projectId: outcome.projectId,
        paidTierId: outcome.paidTierId,
        paidTierName: outcome.paidTierName,
      });
      // Google provisioning the project is what makes the account usable; `markOnboarded`
      // deliberately leaves `enabled` alone, so the release is explicit here — an account
      // parked by an operator or by a TOS block must not stay out of the pool afterwards.
      this.deps.store.setEnabled(id, true);
      // Best-effort: the catalog read is a convenience, not a condition of onboarding.
      const entries = await fetchAvailableModels({
        accessToken,
        projectId: outcome.projectId,
        env: this.deps.env,
        fetchImpl: this.deps.fetchImpl,
      }).catch(() => []);
      if (entries.length > 0) applyCatalog(entries);
      return outcome;
    }

    if (outcome.status === "validation_required") {
      this.deps.store.setStatus(id, "invalid", {
        statusKind: "validation_required",
        lastError: t("account.validationPending", { url: outcome.validationUrl }),
      });
      return outcome;
    }

    this.deps.store.setStatus(id, "invalid", {
      statusKind: "onboarding_pending",
      lastError: t("account.onboardingFailed", {
        id,
        detail: outcome.code === "no_endpoint" ? t("upstream.noEndpoint") : t("oauth.loadCodeAssistNoProject"),
      }),
    });
    return outcome;
  }

  async orderFor(runtimeModel: string): Promise<AccountSnapshot[]> {
    const decision = orderDecision(
      this.deps.store.snapshot(),
      runtimeModel,
      this.now(),
      this.strategy,
      this.inFlight,
    );
    // Relaxing a cooldown is a decision worth seeing: it explains why a "cooling" account
    // served when the pool had nothing else.
    if (decision.relaxed > 0) {
      this.logger.debug({ runtimeModel, relaxed: decision.relaxed }, "cooldowns relaxed");
    }
    return decision.accounts;
  }

  /**
   * Marks an account as serving until the returned release is called. Release is
   * idempotent so a caller can put it in a `finally` without tracking whether it already
   * ran; a counter rather than a set keeps concurrent requests on one account honest.
   */
  acquireInFlight(accountId: string): () => void {
    this.inFlight.set(accountId, (this.inFlight.get(accountId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlight.get(accountId) ?? 1) - 1;
      if (next <= 0) this.inFlight.delete(accountId);
      else this.inFlight.set(accountId, next);
    };
  }

  /**
   * A one-line view of why the pool offered nothing: how many accounts are enabled and how
   * many are benched, with the soonest moment any of them is eligible again. Lets a caller
   * say "the pool is out of quota, it clears in ~X" instead of a generic "no account".
   */
  poolSummary(): { enabled: number; cooling: number; soonestCooldownUntil: number | null } {
    const now = this.now();
    const accounts = this.deps.store.listAccounts();
    // Read from the cooldown table, not from `status`: an account can now be cooling on
    // one family while serving another, and the table is the only place that says which.
    const cooldowns = this.deps.store.cooldowns(now);
    const enabled = accounts.filter((account) => account.enabled);
    const untils = enabled.flatMap((account) =>
      (cooldowns.get(account.id) ?? []).map((row) => row.until),
    );
    return {
      enabled: enabled.length,
      cooling: enabled.filter((account) => (cooldowns.get(account.id)?.length ?? 0) > 0).length,
      soonestCooldownUntil: untils.length > 0 ? Math.min(...untils) : null,
    };
  }

  markUsed(id: string): void {
    this.deps.store.touch(id);
  }

  /**
   * Applies the effect of a failure to the account state (spec §11).
   * A license 403 is a wrapper configuration error, not the account's: it does not change state.
   * A TOS block is the opposite case: it is the account's alone, so it leaves the rotation.
   *
   * A bench is a fact about (account, scope, kind), never a boolean on the account: the
   * scope is the model family that failed, so a drained `gemini-*` family leaves `3p-*`
   * serving. `runtimeModel` is what names that family; without it (a verdict that arrives
   * outside a turn, such as a probe) the bench is account-wide.
   */
  applyFailure(id: string, error: UpstreamError, runtimeModel?: string): void {
    const policy = cooldownPolicy(error.kind);
    if (policy !== null) {
      const now = this.now();
      const scope = runtimeModel === undefined ? "*" : (familyBucketPrefix(runtimeModel) ?? "*");
      // The streak is read before the write: one failure must count once, and the bench
      // and the count are the same row.
      const failures = this.deps.store.failureStreak(id, scope) + 1;
      this.deps.store.recordFailure(id, {
        scope,
        kind: error.kind,
        until:
          failures >= policy.threshold
            ? now + cooldownDuration(policy, error, this.deps.env ?? process.env)
            : null,
        reason: error.message,
      });
      return;
    }
    switch (error.kind) {
      case "validation_required":
        this.deps.store.setStatus(id, "invalid", {
          lastError: t("account.validationRequired", { id }),
          statusKind: "validation_required",
        });
        return;
      case "auth":
        // A recorded block is the only local copy of an upstream account verdict and of its
        // appeal link, and nothing about a token failure reproduces it. Keep the block and
        // stack the credential note on it instead of replacing the whole record.
        {
          const current = this.deps.store.getAccount(id);
          if (current?.statusKind === "tos_blocked") {
            const note = current.lastError ?? "";
            this.deps.store.setStatus(id, "invalid", {
              statusKind: "tos_blocked",
              lastError:
                note.length === 0
                  ? error.message
                  : note.includes(error.message)
                    ? note
                    : `${note} | ${error.message}`,
            });
            return;
          }
        }
        this.deps.store.setStatus(id, "invalid", { lastError: error.message, statusKind: "auth" });
        return;
      case "account_blocked":
        // The ban belongs to this account, so keep it out of the rotation and record why
        // (with the appeal form the backend named). Re-onboarding the account clears the
        // status, which is the way back once Google reinstates it.
        this.deps.store.setStatus(id, "invalid", {
          lastError:
            error.appealUrl === null
              ? t("account.tosBlockedNoAppeal")
              : t("account.tosBlocked", { appeal: error.appealUrl }),
          statusKind: "tos_blocked",
        });
        return;
      default:
        // client_error, model_not_found, server_error, license: no state change.
        return;
    }
  }

  /**
   * Drops the bench a successful turn proved over.
   *
   * Success is the only evidence that the wait ended early, and without this an account
   * stays out of its family's rotation for the whole cooldown after it already recovered.
   * Only the family that just served is released: the other family's bench was not tested.
   */
  clearCooldown(accountId: string, runtimeModel?: string): void {
    const scope = runtimeModel === undefined ? undefined : (familyBucketPrefix(runtimeModel) ?? "*");
    this.deps.store.clearCooldowns(accountId, scope);
  }

  /**
   * Reloads the account's quota and tier, and feeds the public model catalog (spec §6).
   *
   * The catalog supplies the model ids and the free-tier `quotaInfo`; `loadCodeAssistInfo`
   * supplies the tier. The quota itself comes from the configured strategy, which knows
   * not to ask for the summary when the account is known to be free-tier. Both reads are
   * best-effort — a failure must never fail the refresh, must never change the account's
   * state, and must never cancel the other read: a `403 SUBSCRIPTION_REQUIRED` is a fact
   * about the summary, not about the account, which keeps serving requests (spec §3.5, §11).
   */
  async refreshQuota(id: string): Promise<void> {
    const account = this.deps.store.getAccount(id);
    if (!account) return;
    // Provisioning owns the account until it has a project (spec D6): there is nothing
    // to read against, and spending a token refresh on it would be wasted work.
    if (!account.projectId) return;
    const fresh = await this.ensureFresh(account);
    const accessToken = fresh.accessToken ?? "";
    const projectId = fresh.projectId ?? "";

    const [catalog, info] = await Promise.all([
      fetchAvailableModelsWithQuota({
        accessToken,
        projectId,
        env: this.deps.env,
        fetchImpl: this.deps.fetchImpl,
      }),
      loadCodeAssistInfo(accessToken, {
        env: this.deps.env,
        fetchImpl: this.deps.fetchImpl,
      }),
    ]);
    // Empty = failure or empty catalog: does not overwrite what is already usable.
    if (catalog.entries.length > 0) applyCatalog(catalog.entries);
    // Written only when the read actually happened: a failed tier read leaves the
    // previous value in place rather than blanking a display (spec §13).
    if (info) {
      this.deps.store.setPaidTier(id, { id: info.paidTierId, name: info.paidTierName });
    }

    // The just-read tier decides whether the summary RPC is worth calling at all; a
    // failed read falls back to the last tier this account was seen with.
    const isFreeTier = info
      ? info.paidTierId === null || info.paidTierId === "free-tier"
      : fresh.paidTierId === "free-tier";
    const result = await this.quotaStrategy.fetch({
      accessToken,
      projectId,
      isFreeTier,
      catalogQuota: catalog.quota,
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
    });
    this.deps.store.replaceQuota(id, result.rows);
    this.deps.store.setQuotaSummaryError(
      id,
      result.failure === null
        ? null
        : t(
            result.failure.reason === "subscription_required"
              ? "quota.summaryNeedsSubscription"
              : "quota.summaryUnavailable",
            { detail: result.failure.detail },
          ),
    );

    this.logger.info(
      {
        accountId: id,
        models: catalog.entries.length,
        quotaRows: result.rows.length,
        paidTierId: info?.paidTierId ?? null,
        isFreeTier,
        summaryError: result.failure === null ? null : result.failure.reason,
      },
      "quota refreshed",
    );
  }
}
