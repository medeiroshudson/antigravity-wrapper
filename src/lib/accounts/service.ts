import { getCooldownTransientMs } from "../../config/index.js";
import { applyDiscoveredModels } from "../../config/models.js";
import { t } from "../../i18n/index.js";
import { refreshAccessToken } from "../antigravity/oauth.js";
import { fetchAvailableModels } from "../antigravity/quota.js";
import { UpstreamError } from "../antigravity/errors.js";
import { order } from "./selector.js";
import type { Account, AccountSnapshot, AccountStore } from "./store.js";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class AccountService {
  constructor(
    private readonly deps: {
      store: AccountStore;
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

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
      // A dead refresh is a classified authentication failure, not a generic
      // error: this way the runner marks the account `invalid` and moves on to
      // the next candidate (spec §11), instead of aborting the whole request with 502.
      throw new UpstreamError(
        "auth",
        401,
        error instanceof Error ? error.message : t("account.refreshFailed"),
      );
    }
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
   * Reloads the account's quota snapshot from the catalog and feeds the public
   * model catalog with what was discovered (spec §7).
   * Best-effort: `fetchAvailableModels` returns `[]` on failure, and in that case
   * the static table (and the already-discovered catalog) stays intact — a failed
   * refresh must not erase the usable catalog.
   */
  async refreshQuota(id: string): Promise<void> {
    const account = this.deps.store.getAccount(id);
    if (!account) return;
    const fresh = await this.ensureFresh(account);
    const rows = await fetchAvailableModels({
      accessToken: fresh.accessToken ?? "",
      projectId: fresh.projectId ?? "",
      env: this.deps.env,
      fetchImpl: this.deps.fetchImpl,
    });
    this.deps.store.saveQuota(rows.map((row) => ({ ...row, accountId: id })));
    // Empty = failure or empty catalog: does not overwrite what is already usable.
    if (rows.length > 0) {
      applyDiscoveredModels(Object.fromEntries(rows.map((row) => [row.modelId, null])));
    }
  }
}
