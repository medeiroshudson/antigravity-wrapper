import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/lib/accounts/store.js";

let dir: string;
let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agw-"));
  store = new AccountStore(join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function add(id = "a1", email = "x@y.com") {
  return store.upsertAccount({
    id,
    email,
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    accessExpiresAt: Date.now() + 3_600_000,
    projectId: "aicode-consumers",
  });
}

describe("AccountStore", () => {
  it("inserts and reads an account with the state defaults", () => {
    const account = add();
    expect(account.status).toBe("active");
    expect(account.enabled).toBe(true);
    expect(account.priority).toBe(0);
    expect(store.listAccounts()).toHaveLength(1);
  });

  it("creates the database and WAL sidecars with restrictive mode 0600", () => {
    add();
    const dbPath = join(dir, "test.db");
    const existing = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((path) => existsSync(path));
    expect(existing).toContain(dbPath);
    for (const path of existing) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("updates without duplicating on upsert", () => {
    add();
    store.setTokens("a1", { accessToken: "novo", accessExpiresAt: Date.now() + 1000 });
    expect(store.listAccounts()).toHaveLength(1);
    expect(store.getAccount("a1")?.accessToken).toBe("novo");
  });

  it("reactivates the state on upsert and preserves identity fields", () => {
    const createdAt = add().createdAt;
    store.setStatus("a1", "cooldown", { cooldownUntil: Date.now() + 60_000, lastError: "quota" });
    store.setPriority("a1", 5);
    store.setEnabled("a1", false);

    const account = add();

    expect(store.listAccounts()).toHaveLength(1);
    expect(account.status).toBe("active");
    expect(account.cooldownUntil).toBeNull();
    expect(account.lastError).toBeNull();
    expect(account.priority).toBe(5);
    expect(account.enabled).toBe(false);
    expect(account.createdAt).toBe(createdAt);
  });

  it("records a cooldown with until and clears it on reactivation", () => {
    add();
    store.setStatus("a1", "cooldown", { cooldownUntil: Date.now() + 60_000, lastError: "quota" });
    expect(store.getAccount("a1")?.status).toBe("cooldown");
    expect(store.getAccount("a1")?.cooldownUntil).toBeGreaterThan(Date.now());
    store.setStatus("a1", "active");
    expect(store.getAccount("a1")?.cooldownUntil).toBeNull();
  });

  it("reports an expired cooldown as active, keeping the reason it recorded", () => {
    add();
    store.setStatus("a1", "cooldown", {
      cooldownUntil: Date.now() - 1_000,
      lastError: "quota wall",
    });

    // The selector has always treated an expired cooldown as eligible, so the label
    // said "cooldown" while requests were being served — misleading on the admin view.
    expect(store.getAccount("a1")?.status).toBe("active");
    expect(store.getAccount("a1")?.cooldownUntil).toBeNull();
    // The reason stays: it explains why the account was parked in the first place.
    expect(store.getAccount("a1")?.lastError).toBe("quota wall");
    expect(store.listAccounts()[0]?.status).toBe("active");
  });

  it("keeps reporting an unexpired cooldown as cooldown", () => {
    add();
    store.setStatus("a1", "cooldown", { cooldownUntil: Date.now() + 60_000 });

    expect(store.getAccount("a1")?.status).toBe("cooldown");
    expect(store.listAccounts()[0]?.status).toBe("cooldown");
  });

  it("reports a cooldown with no expiry as active, matching the selector", () => {
    add();
    store.setStatus("a1", "cooldown");

    // The selector treats "cooldown without an expiry" as already over, so the label
    // must agree with it rather than contradicting it.
    expect(store.getAccount("a1")?.status).toBe("active");
  });

  it("removes the account and its quotas", () => {
    add();
    store.saveQuota([
      { accountId: "a1", modelId: "gemini-3.8-flash-low", window: "5h", remainingFraction: 1, resetAt: null, fetchedAt: Date.now() },
    ]);
    expect(store.getQuota("a1")).toHaveLength(1);
    store.removeAccount("a1");
    expect(store.listAccounts()).toHaveLength(0);
    expect(store.getQuota("a1")).toHaveLength(0);
  });

  it("replaces the quota snapshot by (account, model, window)", () => {
    add();
    const row = { accountId: "a1", modelId: "m", window: "5h", remainingFraction: 0.5, resetAt: null, fetchedAt: 1 };
    store.saveQuota([row]);
    store.saveQuota([{ ...row, remainingFraction: 0.1, fetchedAt: 2 }]);
    expect(store.getQuota("a1")).toHaveLength(1);
    expect(store.getQuota("a1")[0]?.remainingFraction).toBe(0.1);
  });

  it("consumes the pending OAuth exactly once", () => {
    store.savePendingOAuth("state-1", "verifier-1");
    expect(store.takePendingOAuth("state-1")?.verifier).toBe("verifier-1");
    expect(store.takePendingOAuth("state-1")).toBeUndefined();
  });

  it("does not return an expired pending OAuth", () => {
    store.savePendingOAuth("state-2", "verifier-2", Date.now() - 10 * 60_000);
    expect(store.takePendingOAuth("state-2")).toBeUndefined();
  });

  it("returns a snapshot with aggregated quota", () => {
    add();
    store.saveQuota([
      { accountId: "a1", modelId: "m", window: "5h", remainingFraction: 0.8, resetAt: null, fetchedAt: Date.now() },
    ]);
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.quota).toHaveLength(1);
  });
});
