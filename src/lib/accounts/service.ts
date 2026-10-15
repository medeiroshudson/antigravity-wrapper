import { getCooldownTransientMs } from "../../config/index.js";
import { applyCatalog } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import { loadCodeAssistInfo, refreshAccessToken } from "../antigravity/oauth.js";
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
   */
  applyFailure(id: string, error: UpstreamError): void {
    const now = this.now();
    switch (error.kind) {
      case "quota":
        this.deps.store.setStatus(id, "cooldown", {
          cooldownUntil: now + (error.retryAfterMs ?? getCooldownTransientMs(this.deps.env)),
          lastError: error.message,
        });
        return;
      case "transient_rate_limit":
        // The spec's error table keeps the pool unchanged for transient throttling
        // (spec §11): the account is healthy and its quota is intact, so cooling it
        // down only took it out of rotation for the whole window. The runner retries
        // it after a short backoff instead.
        return;
      case "validation_required":
        this.deps.store.setStatus(id, "invalid", {
          lastError: t("account.validationRequired"),
        });
        return;
      case "auth":
        this.deps.store.setStatus(id, "invalid", { lastError: error.message });
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
