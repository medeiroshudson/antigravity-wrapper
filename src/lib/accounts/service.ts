import { getCooldownTransientMs } from "../../config/index.js";
import { applyCatalog } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import { loadCodeAssistInfo, onboardAccount, refreshAccessToken, type OnboardingOutcome } from "../antigravity/oauth.js";
import { fetchAvailableModels, retrieveUserQuotaSummary } from "../antigravity/quota.js";
import { UpstreamError } from "../antigravity/errors.js";
import { noopLogger, type Logger } from "../logger.js";
import { order } from "./selector.js";
import type { Account, AccountSnapshot, AccountStore } from "./store.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class AccountService {
  private readonly logger: Logger;

  constructor(
    private readonly deps: {
      store: AccountStore;
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      now?: () => number;
      logger?: Logger;
    },
  ) {
    this.logger = deps.logger ?? noopLogger;
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
      // A dead refresh is a classified authentication failure, not a generic
      // error: this way the runner marks the account `invalid` and moves on to
      // the next candidate (spec §11), instead of aborting the whole request with 502.
      throw new UpstreamError(
        "auth",
        401,
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
    return order(this.deps.store.snapshot(), runtimeModel, this.now());
  }

  /**
   * A one-line view of why the pool offered nothing: how many accounts are enabled and how
   * many are benched, with the soonest moment any of them is eligible again. Lets a caller
   * say "the pool is out of quota, it clears in ~X" instead of a generic "no account".
   */
  poolSummary(): { enabled: number; cooling: number; soonestCooldownUntil: number | null } {
    const now = this.now();
    const accounts = this.deps.store.listAccounts();
    const enabled = accounts.filter((account) => account.enabled).length;
    const cooldowns = accounts
      .filter((account) => account.enabled && account.cooldownUntil !== null && account.cooldownUntil > now)
      .map((account) => account.cooldownUntil as number);
    return {
      enabled,
      cooling: cooldowns.length,
      soonestCooldownUntil: cooldowns.length > 0 ? Math.min(...cooldowns) : null,
    };
  }

  markUsed(id: string): void {
    this.deps.store.touch(id);
  }

  /**
   * Applies the effect of a failure to the account state (spec §11).
   * A license 403 is a wrapper configuration error, not the account's: it does not change state.
   * A TOS block is the opposite case: it is the account's alone, so it leaves the rotation.
   */
  applyFailure(id: string, error: UpstreamError): void {
    const now = this.now();
    switch (error.kind) {
      case "quota":
      case "transient_rate_limit":
        this.deps.store.setStatus(id, "cooldown", {
          cooldownUntil: now + (error.retryAfterMs ?? getCooldownTransientMs(this.deps.env)),
          lastError: error.message,
          statusKind: error.kind === "quota" ? "quota" : "rate_limited",
        });
        return;
      case "validation_required":
        this.deps.store.setStatus(id, "invalid", {
          lastError: t("account.validationRequired", { id }),
          statusKind: "validation_required",
        });
        return;
      case "auth":
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
   * Reloads the account's quota and tier, and feeds the public model catalog (spec §6).
   *
   * Three reads with different duties: `fetchAvailableModels` supplies the model ids,
   * `retrieveUserQuotaSummary` supplies the quota the admin surface displays, and
   * `loadCodeAssistInfo` supplies the tier that explains whether that quota is readable.
   * All three are best-effort — a failure must never fail the refresh, must never change
   * the account's state, and must never cancel the other reads: a `403
   * SUBSCRIPTION_REQUIRED` is a fact about the summary, not about the account, which
   * keeps serving requests (spec §3.5, §11).
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

    const entries = await fetchAvailableModels({
      accessToken,
      projectId,
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
    });
    // Empty = failure or empty catalog: does not overwrite what is already usable.
    if (entries.length > 0) applyCatalog(entries);

    const summary = await retrieveUserQuotaSummary({
      accessToken,
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
    });
    // Always replaces: on failure the rows go away, so the response reports no groups
    // rather than a reading the refresh could not confirm.
    this.deps.store.replaceQuota(id, summary.rows);
    this.deps.store.setQuotaSummaryError(
      id,
      summary.failure === null
        ? null
        : t(
            summary.failure.reason === "subscription_required"
              ? "quota.summaryNeedsSubscription"
              : "quota.summaryUnavailable",
            { detail: summary.failure.detail },
          ),
    );

    const info = await loadCodeAssistInfo(accessToken, {
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
    });
    // Written only when the read actually happened: a failed tier read leaves the
    // previous value in place rather than blanking a display (spec §13).
    if (info) {
      this.deps.store.setPaidTier(id, { id: info.paidTierId, name: info.paidTierName });
    }

    this.logger.info(
      {
        accountId: id,
        models: entries.length,
        quotaRows: summary.rows.length,
        paidTierId: info?.paidTierId ?? null,
        summaryError: summary.failure === null ? null : summary.failure.reason,
      },
      "quota refreshed",
    );
  }
}
