import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelsTtlMs, getQuotaRefreshTtlMs } from "../src/config/index.js";
import { startCatalogRefresh } from "../src/lib/runtime.js";
import type { AccountService } from "../src/lib/accounts/service.js";
import type { AccountStore } from "../src/lib/accounts/store.js";

interface FakeAccount {
  id: string;
  enabled: boolean;
  status: string;
}

function makeDeps(accounts: FakeAccount[]) {
  const refreshQuota = vi.fn(async (_id: string) => undefined);
  const store = { listAccounts: () => accounts } as unknown as AccountStore;
  const service = { refreshQuota } as unknown as AccountService;
  return { store, service, refreshQuota };
}

const ENV = { QUOTA_REFRESH_TTL_MS: "1000", MODELS_TTL_MS: "5000" };

describe("startCatalogRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at boot and again at the quota and catalog TTLs", async () => {
    vi.useFakeTimers();
    const { store, service, refreshQuota } = makeDeps([{ id: "a1", enabled: true, status: "active" }]);
    const handle = startCatalogRefresh(ENV, { store, service });

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshQuota).toHaveBeenCalledWith("a1");

    refreshQuota.mockClear();
    await vi.advanceTimersByTimeAsync(getQuotaRefreshTtlMs(ENV));
    expect(refreshQuota).toHaveBeenCalledWith("a1");

    refreshQuota.mockClear();
    await vi.advanceTimersByTimeAsync(getModelsTtlMs(ENV));
    expect(refreshQuota).toHaveBeenCalledWith("a1");

    handle.stop();
  });

  it("skips disabled or invalid accounts", async () => {
    vi.useFakeTimers();
    const { store, service, refreshQuota } = makeDeps([
      { id: "a1", enabled: false, status: "active" },
      { id: "a2", enabled: true, status: "invalid" },
      { id: "a3", enabled: true, status: "active" },
    ]);
    const handle = startCatalogRefresh(ENV, { store, service });

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    expect(refreshQuota).toHaveBeenCalledWith("a3");

    handle.stop();
  });
});
