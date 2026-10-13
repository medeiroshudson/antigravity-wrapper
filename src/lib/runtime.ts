import { getDbPath, getModelsTtlMs, getQuotaRefreshTtlMs } from "../config/index.js";
import { AccountService } from "./accounts/service.js";
import { AccountStore } from "./accounts/store.js";

let store: AccountStore | null = null;
let service: AccountService | null = null;

export function getStore(env: NodeJS.ProcessEnv = process.env): AccountStore {
  if (!store) store = new AccountStore(getDbPath(env));
  return store;
}

export function getAccountService(env: NodeJS.ProcessEnv = process.env): AccountService {
  if (!service) service = new AccountService({ store: getStore(env), env });
  return service;
}

export function resetRuntime(): void {
  store?.close();
  store = null;
  service = null;
}

/**
 * Drives the catalog/quota discovery loop (spec §7, §9.3): one pass at boot and
 * further passes on the quota and catalog TTLs that config already defines.
 *
 * Lives only in the production entrypoint (`server.ts`, the `isMain` block), never
 * in `buildServer`, so tests injecting a store/fetch never open the real database
 * nor touch the network. Takes injectable instances for testing the loop itself.
 */
export function startCatalogRefresh(
  env: NodeJS.ProcessEnv = process.env,
  deps: { store?: AccountStore; service?: AccountService } = {},
): { stop: () => void } {
  const store = deps.store ?? getStore(env);
  const service = deps.service ?? getAccountService(env);

  const pass = async (): Promise<void> => {
    for (const account of store.listAccounts()) {
      if (!account.enabled || account.status === "invalid") continue;
      await service.refreshQuota(account.id).catch(() => undefined);
    }
  };

  void pass();
  const quotaTimer = setInterval(() => void pass(), getQuotaRefreshTtlMs(env));
  const modelsTimer = setInterval(() => void pass(), getModelsTtlMs(env));

  return {
    stop: () => {
      clearInterval(quotaTimer);
      clearInterval(modelsTimer);
    },
  };
}
