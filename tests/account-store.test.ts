import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore, accountState } from "../src/lib/accounts/store.js";

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

function bucket(over: Partial<Parameters<AccountStore["replaceQuota"]>[1][number]> = {}) {
  return {
    bucketId: "gemini-weekly",
    window: "weekly",
    displayName: "Weekly Limit Remaining",
    groupName: "Gemini Models",
    groupDescription: "Models within this group: Gemini Flash, Gemini Pro",
    bucketDescription: "You have used some of your weekly limit.",
    remainingFraction: 0.5,
    resetAt: 1_700_000_000_000,
    fetchedAt: 1,
    ...over,
  };
}

describe("AccountStore", () => {
  it("inserts and reads an account with the state defaults", () => {
    const account = add();
    expect(account.status).toBe("active");
    expect(account.enabled).toBe(true);
    expect(account.priority).toBe(0);
    expect(account.quotaSummaryError).toBeNull();
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

  it("backfills an account parked before the cause column existed", () => {
    add();
    store.raw().exec("UPDATE accounts SET enabled = 0, status_kind = NULL, last_error = NULL");
    store.close();

    store = new AccountStore(join(dir, "test.db"));
    expect(store.getAccount("a1")).toMatchObject({
      enabled: false,
      statusKind: "operator_disabled",
      lastError: "disabled by operator",
    });
  });

  it("records why an account was disabled, and clears that note on re-enable", () => {
    add();
    store.setEnabled("a1", false);
    expect(store.getAccount("a1")).toMatchObject({
      enabled: false,
      statusKind: "operator_disabled",
      lastError: "disabled by operator",
    });

    store.setEnabled("a1", true);
    expect(store.getAccount("a1")).toMatchObject({ enabled: true, statusKind: null, lastError: null });
  });

  it("keeps an upstream verdict when the operator parks or releases the account", () => {
    // Disabling says "I parked it"; it does not erase why the upstream refuses it.
    add();
    store.setStatus("a1", "invalid", { lastError: "blocked", statusKind: "tos_blocked" });
    store.setEnabled("a1", false);
    expect(store.getAccount("a1")).toMatchObject({ statusKind: "tos_blocked", lastError: "blocked" });

    store.setEnabled("a1", true);
    expect(store.getAccount("a1")).toMatchObject({ statusKind: "tos_blocked", lastError: "blocked" });
  });

  it("derives the effective state, with invalid outranking disabled", () => {
    add();
    const now = Date.now();
    expect(accountState(store.getAccount("a1")!, now)).toBe("active");

    store.setEnabled("a1", false);
    expect(accountState(store.getAccount("a1")!, now)).toBe("disabled");

    store.setStatus("a1", "invalid", { lastError: "blocked", statusKind: "tos_blocked" });
    expect(accountState(store.getAccount("a1")!, now)).toBe("invalid");
  });

  it("drops a quota park from the cause once the cooldown expires, keeping the history", () => {
    add();
    store.setStatus("a1", "cooldown", {
      cooldownUntil: Date.now() - 1,
      lastError: "quota wall",
      statusKind: "quota",
    });
    const account = store.getAccount("a1");
    expect(account?.status).toBe("active");
    expect(account?.statusKind).toBeNull();
    expect(account?.lastError).toBe("quota wall");
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

  it("clears a recorded summary error on re-login", () => {
    add();
    store.setQuotaSummaryError("a1", "needs a subscription");
    expect(add().quotaSummaryError).toBeNull();
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

  it("removes the account and its quota", () => {
    add();
    store.replaceQuota("a1", [bucket()]);
    expect(store.getQuota("a1")).toHaveLength(1);
    store.removeAccount("a1");
    expect(store.listAccounts()).toHaveLength(0);
    expect(store.getQuota("a1")).toHaveLength(0);
  });

  it("stores every field of a bucket row", () => {
    add();
    store.replaceQuota("a1", [bucket({ bucketId: "3p-5h", window: "5h", remainingFraction: 0.974784 })]);
    const [row] = store.getQuota("a1");
    expect(row).toEqual({
      accountId: "a1",
      bucketId: "3p-5h",
      window: "5h",
      displayName: "Weekly Limit Remaining",
      groupName: "Gemini Models",
      groupDescription: "Models within this group: Gemini Flash, Gemini Pro",
      bucketDescription: "You have used some of your weekly limit.",
      remainingFraction: 0.974784,
      resetAt: 1_700_000_000_000,
      fetchedAt: 1,
    });
  });

  it("returns the buckets in insertion order, so the backend's order survives storage", () => {
    add();
    store.replaceQuota("a1", [bucket({ bucketId: "gemini-weekly" }), bucket({ bucketId: "gemini-5h" })]);
    // The API promises the backend's order (spec D6). Without an explicit ORDER BY the
    // primary-key index returns these alphabetically, reporting 5h before weekly.
    expect(store.getQuota("a1").map((row) => row.bucketId)).toEqual(["gemini-weekly", "gemini-5h"]);
  });

  it("replaces the whole snapshot, so a vanished bucket does not linger", () => {
    add();
    store.replaceQuota("a1", [bucket(), bucket({ bucketId: "gemini-5h", groupName: "Gemini Models" })]);
    expect(store.getQuota("a1")).toHaveLength(2);

    // A later refresh that no longer reports a bucket must not leave the stale row
    // behind: the reading is "as of fetchedAt", and a lingering row would contradict it.
    store.replaceQuota("a1", [bucket({ bucketId: "gemini-5h", remainingFraction: 0.1 })]);
    const rows = store.getQuota("a1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bucketId).toBe("gemini-5h");
    expect(rows[0]?.remainingFraction).toBe(0.1);
  });

  it("clears the snapshot when the refresh reports nothing", () => {
    add();
    store.replaceQuota("a1", [bucket()]);
    store.replaceQuota("a1", []);
    expect(store.getQuota("a1")).toEqual([]);
  });

  it("round-trips the summary error and clears it on null", () => {
    add();
    store.setQuotaSummaryError("a1", "the summary needs a paid subscription");
    expect(store.getAccount("a1")?.quotaSummaryError).toBe("the summary needs a paid subscription");
    store.setQuotaSummaryError("a1", null);
    expect(store.getAccount("a1")?.quotaSummaryError).toBeNull();
  });

  it("starts with an unknown tier and stores both halves of it", () => {
    add();
    // Unknown, not "free": an account whose tier was never read must not be reported
    // as having no subscription.
    expect(store.getAccount("a1")?.paidTierId).toBeNull();
    expect(store.getAccount("a1")?.paidTierName).toBeNull();

    store.setPaidTier("a1", { id: "g1-pro-tier", name: "Google AI Pro" });
    expect(store.getAccount("a1")?.paidTierId).toBe("g1-pro-tier");
    expect(store.getAccount("a1")?.paidTierName).toBe("Google AI Pro");
  });

  it("stores the free tier as a tier, not as an absence", () => {
    add();
    store.setPaidTier("a1", { id: "free-tier", name: "Antigravity Starter Quota" });
    // The measured payload (spec §3.6): a free account carries a tier object whose id
    // is "free-tier". Reading null here would report "no tier" for a real one.
    expect(store.getAccount("a1")?.paidTierId).toBe("free-tier");
    expect(store.getAccount("a1")?.paidTierName).toBe("Antigravity Starter Quota");
  });

  it("overwrites the tier with whatever it is given, including nulls", () => {
    add();
    store.setPaidTier("a1", { id: "g1-pro-tier", name: "Google AI Pro" });
    store.setPaidTier("a1", { id: null, name: null });
    // The store is dumb on purpose: preserving a previous tier when a read fails is the
    // service's decision (spec §13), not something to smuggle into a setter.
    expect(store.getAccount("a1")?.paidTierId).toBeNull();
    expect(store.getAccount("a1")?.paidTierName).toBeNull();
  });

  it("markOnboarded stores the project and the tier and clears any recorded refusal in one write", () => {
    store.upsertAccount({ id: "a1", email: "a1@x.com", refreshToken: "r", accessToken: "t", accessExpiresAt: 0, projectId: null });
    store.setStatus("a1", "invalid", { statusKind: "tos_blocked", lastError: "blocked" });

    store.markOnboarded("a1", { projectId: "aicode-consumers", paidTierId: "free-tier", paidTierName: "Free" });

    expect(store.getAccount("a1")).toMatchObject({
      projectId: "aicode-consumers",
      paidTierId: "free-tier",
      paidTierName: "Free",
      status: "active",
      statusKind: null,
      cooldownUntil: null,
      lastError: null,
    });
  });

  it("markOnboarded retires a recorded cooldown", () => {
    store.upsertAccount({ id: "a1", email: "a1@x.com", refreshToken: "r", accessToken: "t", accessExpiresAt: 0, projectId: null });
    store.setStatus("a1", "cooldown", { cooldownUntil: Date.now() + 60_000, statusKind: "quota", lastError: "quota wall" });
    expect(store.getAccount("a1")?.cooldownUntil).not.toBeNull();

    store.markOnboarded("a1", { projectId: "aicode-consumers", paidTierId: "free-tier", paidTierName: "Free" });

    expect(store.getAccount("a1")).toMatchObject({
      projectId: "aicode-consumers", status: "active", statusKind: null, cooldownUntil: null, lastError: null,
    });
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

  it("clears lastError and updates lastUsedAt when touched", () => {
    add();
    store.setStatus("a1", "cooldown", { lastError: "Resource exhausted" });
    expect(store.getAccount("a1")?.lastError).toBe("Resource exhausted");

    store.touch("a1");
    const account = store.getAccount("a1");
    expect(account?.lastError).toBeNull();
    expect(account?.lastUsedAt).not.toBeNull();
  });

  it("returns a snapshot with the account's buckets", () => {
    add();
    store.replaceQuota("a1", [bucket()]);
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.quota).toHaveLength(1);
    expect(snapshot[0]?.cooldowns).toEqual([]);
    expect(snapshot[0]?.quotaSummaryError).toBeNull();
  });
});

describe("AccountStore scoped cooldowns", () => {
  const NOW = 2_000_000_000_000;

  it("counts failures per scope and benches only when told to", () => {
    add();
    const first = store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: null,
      reason: "slow down",
    });
    const second = store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: null,
      reason: "slow down",
    });
    expect([first, second]).toEqual([1, 2]);
    // A count is not a bench: nothing is cooling yet.
    expect(store.cooldownsFor("a1", NOW)).toEqual([]);

    expect(
      store.recordFailure("a1", {
        scope: "gemini-",
        kind: "transient_rate_limit",
        until: NOW + 30_000,
        reason: "slow down",
      }),
    ).toBe(3);
    expect(store.cooldownsFor("a1", NOW)).toEqual([
      { scope: "gemini-", kind: "transient_rate_limit", until: NOW + 30_000, reason: "slow down", failures: 3 },
    ]);
  });

  it("keeps one row per scope, so one family's bench leaves the other intact", () => {
    add();
    store.recordFailure("a1", { scope: "gemini-", kind: "quota", until: NOW + 60_000, reason: "gemini wall" });
    store.recordFailure("a1", { scope: "3p-", kind: "quota", until: NOW + 60_000, reason: "3p wall" });
    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope).sort()).toEqual(["3p-", "gemini-"]);

    store.clearCooldowns("a1", "gemini-");
    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope)).toEqual(["3p-"]);

    store.clearCooldowns("a1");
    expect(store.cooldownsFor("a1", NOW)).toEqual([]);
  });

  it("retires a bench whose time has passed and keeps a live one", () => {
    add();
    store.recordFailure("a1", { scope: "gemini-", kind: "quota", until: NOW - 1, reason: "old wall" });
    store.recordFailure("a1", { scope: "3p-", kind: "quota", until: NOW + 60_000, reason: "live wall" });

    store.expireCooldowns(NOW);

    expect(store.cooldownsFor("a1", NOW).map((row) => row.scope)).toEqual(["3p-"]);
  });

  it("projects the widest active cooldown into the columns the admin surface reads", () => {
    add();
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: NOW + 30_000,
      reason: "slow down",
    });
    store.recordFailure("a1", { scope: "3p-", kind: "quota", until: NOW + 90_000, reason: "3p wall" });

    const account = store.getAccount("a1");
    // The table is the source of truth; `status`/`cooldownUntil` exist so every reader
    // does not have to join. The widest bench is what the account as a whole is waiting on.
    expect(account).toMatchObject({
      status: "cooldown",
      cooldownUntil: NOW + 90_000,
      statusKind: "quota",
      lastError: "3p wall",
    });
  });

  it("does not shorten an active quota wall or downgrade its kind on subsequent transient failures", () => {
    add();
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "quota",
      until: NOW + 100_000,
      reason: "quota wall",
    });

    // A shorter transient throttle arrives concurrently or during relaxation probe
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: NOW + 20_000,
      reason: "rate limited",
    });

    const cooldowns = store.cooldownsFor("a1", NOW);
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]).toEqual({
      scope: "gemini-",
      kind: "quota",
      until: NOW + 100_000,
      reason: "quota wall",
      failures: 2,
    });
    // The projected account lastError and statusKind preserve the quota wall
    expect(store.getAccount("a1")).toMatchObject({
      status: "cooldown",
      statusKind: "quota",
      cooldownUntil: NOW + 100_000,
      lastError: "quota wall",
    });
  });

  it("does not overwrite an active bench when a count-only failure arrives", () => {
    add();
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "quota",
      until: NOW + 50_000,
      reason: "quota wall",
    });

    // Count-only failure (until: null) arrives
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: null,
      reason: "just counting",
    });

    const cooldowns = store.cooldownsFor("a1", NOW);
    expect(cooldowns[0]).toEqual({
      scope: "gemini-",
      kind: "quota",
      until: NOW + 50_000,
      reason: "quota wall",
      failures: 2,
    });
  });

  it("upgrades a transient cooldown to quota when a quota wall is hit", () => {
    add();
    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "transient_rate_limit",
      until: NOW + 20_000,
      reason: "rate limited",
    });

    store.recordFailure("a1", {
      scope: "gemini-",
      kind: "quota",
      until: NOW + 60_000,
      reason: "quota wall",
    });

    const cooldowns = store.cooldownsFor("a1", NOW);
    expect(cooldowns[0]).toEqual({
      scope: "gemini-",
      kind: "quota",
      until: NOW + 60_000,
      reason: "quota wall",
      failures: 2,
    });
  });

  it("goes back to active when the only bench expires, keeping the reason", () => {
    add();
    store.recordFailure("a1", {
      scope: "*",
      kind: "quota",
      until: Date.now() - 1_000,
      reason: "quota wall",
    });

    // Retiring the row is what reports the account as serving again; the reason stays on
    // the account because it explains why it was parked at all.
    expect(store.getAccount("a1")).toMatchObject({
      status: "active",
      cooldownUntil: null,
      statusKind: null,
      lastError: "quota wall",
    });
  });

  it("carries the active cooldowns into the snapshot the selector reads", () => {
    add();
    store.recordFailure("a1", {
      scope: "3p-",
      kind: "quota",
      until: Date.now() + 60_000,
      reason: "3p wall",
    });

    expect(store.snapshot()[0]?.cooldowns).toEqual([
      expect.objectContaining({ scope: "3p-", kind: "quota" }),
    ]);
  });

  it("drops an account's cooldowns with the account and on re-login", () => {
    add();
    store.recordFailure("a1", { scope: "*", kind: "quota", until: Date.now() + 60_000, reason: "wall" });

    add();
    expect(store.cooldownsFor("a1")).toEqual([]);

    store.recordFailure("a1", { scope: "*", kind: "quota", until: Date.now() + 60_000, reason: "wall" });
    store.removeAccount("a1");
    expect(store.cooldownsFor("a1")).toEqual([]);
  });
});

describe("AccountStore cooldown migration", () => {
  it("moves a legacy status cooldown into the table and clears the columns", () => {
    const path = join(dir, "legacy-cooldown.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT, access_expires_at INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        cooldown_until INTEGER, last_error TEXT, status_kind TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO accounts (id, email, refresh_token, access_token, access_expires_at, project_id,
         status, cooldown_until, last_error, status_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy", "l@x.com", "r", "a", Date.now() + 3_600_000, "p", "cooldown", Date.now() + 60_000, "quota wall", "rate_limited", 1);
    db.close();

    const migrated = new AccountStore(path);
    const account = migrated.getAccount("legacy");

    // One fact, one table: the row carries the wait, the account stays serving once it ends.
    expect(migrated.cooldownsFor("legacy")).toEqual([
      {
        scope: "*",
        // The legacy status kind was the admin vocabulary; the table speaks failure kinds.
        kind: "transient_rate_limit",
        until: expect.any(Number),
        reason: "quota wall",
        failures: 1,
      },
    ]);
    expect(account?.status).toBe("cooldown");

    const raw = migrated.raw().prepare("SELECT status, cooldown_until FROM accounts WHERE id = 'legacy'").get() as {
      status: string;
      cooldown_until: number | null;
    };
    expect(raw.status).toBe("active");
    expect(raw.cooldown_until).toBeNull();
    migrated.close();
  });

  it("is idempotent, so a second boot adds no duplicate row", () => {
    const path = join(dir, "legacy-cooldown.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT, access_expires_at INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        cooldown_until INTEGER, last_error TEXT, status_kind TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO accounts (id, refresh_token, status, cooldown_until, status_kind, created_at)
       VALUES ('legacy', 'r', 'cooldown', ?, 'quota', 1)`,
    ).run(Date.now() + 60_000);
    db.close();

    const first = new AccountStore(path);
    const rowsAfterFirst = first.raw().prepare("SELECT COUNT(*) AS n FROM account_cooldowns").get() as { n: number };
    first.close();

    const second = new AccountStore(path);
    const rowsAfterSecond = second.raw().prepare("SELECT COUNT(*) AS n FROM account_cooldowns").get() as { n: number };
    second.close();

    expect(rowsAfterFirst.n).toBe(1);
    expect(rowsAfterSecond.n).toBe(1);
  });
});

describe("AccountStore migration", () => {
  /** A database in the shape the previous release wrote: per-model rows, no error column. */
  function seedLegacyDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT, access_expires_at INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        cooldown_until INTEGER, last_error TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE quota_snapshots (
        account_id TEXT NOT NULL, model_id TEXT NOT NULL, window TEXT NOT NULL,
        remaining_fraction REAL NOT NULL, reset_at INTEGER, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, model_id, window)
      );
      CREATE TABLE oauth_pending (
        state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO accounts (id, email, refresh_token, access_token, access_expires_at, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy", "l@x.com", "refresh-legacy", "access-legacy", Date.now() + 3_600_000, "p", 1);
    db.prepare(
      `INSERT INTO quota_snapshots (account_id, model_id, window, remaining_fraction, reset_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("legacy", "gemini-3.8-flash-low", "model", 0.5, null, 1);
    db.close();
  }

  it("keeps the accounts and their tokens while rebuilding the quota table", () => {
    const path = join(dir, "legacy.db");
    seedLegacyDatabase(path);

    const migrated = new AccountStore(path);
    const account = migrated.getAccount("legacy");

    // The accounts table is not derived cache: losing a refresh token loses the account.
    expect(account?.refreshToken).toBe("refresh-legacy");
    expect(account?.accessToken).toBe("access-legacy");
    expect(account?.quotaSummaryError).toBeNull();
    // The per-model rows are gone; the bucket-keyed table starts empty (spec §7).
    expect(migrated.getQuota("legacy")).toEqual([]);
    migrated.close();
  });

  it("adds the tier columns to a legacy database as nulls, not as a tier", () => {
    const path = join(dir, "legacy.db");
    seedLegacyDatabase(path);

    const migrated = new AccountStore(path);
    const account = migrated.getAccount("legacy");

    // A legacy row has no tier on record. Reporting anything but unknown would invent
    // a fact about the account's subscription.
    expect(account?.paidTierId).toBeNull();
    expect(account?.paidTierName).toBeNull();
    migrated.setPaidTier("legacy", { id: "g1-pro-tier", name: "Google AI Pro" });
    expect(migrated.getAccount("legacy")?.paidTierId).toBe("g1-pro-tier");
    migrated.close();
  });

  it("is a no-op on a second start, so snapshots survive a restart", () => {
    const path = join(dir, "legacy.db");
    seedLegacyDatabase(path);

    const first = new AccountStore(path);
    first.replaceQuota("legacy", [bucket()]);
    first.close();

    const second = new AccountStore(path);
    // Without the version guard this DROP+CREATE would run at every boot and no
    // snapshot would ever outlive a restart.
    expect(second.getQuota("legacy")).toHaveLength(1);
    second.close();
  });

  it("creates the current schema on a fresh database", () => {
    const path = join(dir, "fresh.db");
    const fresh = new AccountStore(path);
    const version = fresh.raw().prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    expect(version?.user_version).toBe(1);
    fresh.close();
  });
});
