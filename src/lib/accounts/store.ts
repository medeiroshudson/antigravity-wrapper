import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { t } from "../../i18n/index.js";

export type AccountStatus = "active" | "cooldown" | "invalid";

export interface Account {
  id: string;
  email: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAt: number;
  projectId: string | null;
  status: AccountStatus;
  cooldownUntil: number | null;
  lastError: string | null;
  quotaSummaryError: string | null;
  paidTierId: string | null;
  paidTierName: string | null;
  enabled: boolean;
  priority: number;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * One bucket of one group, as the summary RPC reports it (spec §3.1). The names and
 * descriptions are stored exactly as the backend sends them and never reconstructed
 * on read: if the backend renames a label the display follows without a release.
 */
export interface QuotaBucket {
  accountId: string;
  bucketId: string;
  window: string;
  displayName: string | null;
  groupName: string | null;
  groupDescription: string | null;
  bucketDescription: string | null;
  remainingFraction: number;
  resetAt: number | null;
  fetchedAt: number;
}

export type AccountSnapshot = Account & { quota: QuotaBucket[] };

const PENDING_OAUTH_TTL_MS = 5 * 60 * 1000;
const SCHEMA_VERSION = 1;

interface Row {
  id: string;
  email: string | null;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: number;
  project_id: string | null;
  status: string;
  cooldown_until: number | null;
  last_error: string | null;
  quota_summary_error: string | null;
  paid_tier_id: string | null;
  paid_tier_name: string | null;
  enabled: number;
  priority: number;
  created_at: number;
  last_used_at: number | null;
}

function toAccount(row: Row): Account {
  return {
    id: row.id,
    email: row.email,
    refreshToken: row.refresh_token,
    accessToken: row.access_token,
    accessExpiresAt: row.access_expires_at,
    projectId: row.project_id,
    status: row.status as AccountStatus,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    quotaSummaryError: row.quota_summary_error,
    paidTierId: row.paid_tier_id,
    paidTierName: row.paid_tier_name,
    enabled: row.enabled === 1,
    priority: row.priority,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export class AccountStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // 0600 before enabling WAL: the -wal/-shm sidecars clone the database file's
    // mode when they are created, so the restrictive mode must come first.
    this.applyRestrictiveMode(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT, access_expires_at INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, status TEXT NOT NULL DEFAULT 'active',
        cooldown_until INTEGER, last_error TEXT, quota_summary_error TEXT,
        paid_tier_id TEXT, paid_tier_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_pending (
        state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    // quota_snapshots is created by the migrator, not here: the migrator's job is to
    // drop a previous shape and install the current one, in one place.
    this.migrate();
    // Reinforcement: WAL just created the sidecars; ensure 0600 on them too.
    this.applyRestrictiveMode(dbPath);
  }

  /**
   * Brings an existing database to the current schema, once.
   *
   * Versioned through `PRAGMA user_version` because the v1 step is destructive: without
   * the guard the quota table would be rebuilt at every boot and no snapshot would
   * outlive a restart (spec §7). The accounts table is never dropped: it holds the
   * refresh tokens, which are not derived cache.
   */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return;

    // v1: quota rows move from one per model to one per bucket. Derived cache,
    // repopulated by the next refresh, so dropping it is safe (spec §7).
    this.db.exec("DROP TABLE IF EXISTS quota_snapshots");
    this.db.exec(`
      CREATE TABLE quota_snapshots (
        account_id TEXT NOT NULL, bucket_id TEXT NOT NULL, window TEXT NOT NULL,
        display_name TEXT, group_name TEXT, group_description TEXT, bucket_description TEXT,
        remaining_fraction REAL NOT NULL, reset_at INTEGER, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, bucket_id)
      );
    `);
    const added: Array<[string, string]> = [
      ["quota_summary_error", "TEXT"],
      ["paid_tier_id", "TEXT"],
      ["paid_tier_name", "TEXT"],
    ];
    for (const [column, type] of added) {
      if (!this.hasColumn("accounts", column)) {
        // Column names are literals from this table, never caller input, so the
        // interpolation cannot be injected through.
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${type}`);
      }
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  /** Test seam: the raw handle, so schema assertions need no second connection. */
  raw(): DatabaseSync {
    return this.db;
  }

  private applyRestrictiveMode(dbPath: string): void {
    if (dbPath === ":memory:") return;
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // platform without file-mode support, or a sidecar that does not exist yet
      }
    }
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(input: {
    id: string;
    email: string | null;
    refreshToken: string;
    accessToken: string | null;
    accessExpiresAt: number;
    projectId: string | null;
  }): Account {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, email, refresh_token, access_token, access_expires_at, project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           project_id = excluded.project_id, status = 'active', cooldown_until = NULL,
           last_error = NULL, quota_summary_error = NULL`,
      )
      .run(input.id, input.email, input.refreshToken, input.accessToken, input.accessExpiresAt, input.projectId, now);
    const account = this.getAccount(input.id);
    if (!account) throw new Error(t("account.notFoundAfterUpsert", { id: input.id }));
    return account;
  }

  /**
   * Retires cooldowns whose time has passed, so the reported status matches what the
   * selector actually does with them (spec §9.1: `cooldown --expira--> active`). The
   * selector has always admitted these accounts, so without this the admin view reads
   * "cooldown" while requests are being served.
   *
   * The recorded `last_error` is kept: it is why the account was parked, and it stays
   * useful after the account is back in rotation.
   */
  private expireCooldowns(now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE accounts SET status = 'active', cooldown_until = NULL
         WHERE status = 'cooldown' AND (cooldown_until IS NULL OR cooldown_until <= ?)`,
      )
      .run(now);
  }

  getAccount(id: string): Account | undefined {
    this.expireCooldowns();
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? toAccount(row) : undefined;
  }

  listAccounts(): Account[] {
    this.expireCooldowns();
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY priority DESC, created_at ASC")
      .all() as unknown as Row[];
    return rows.map(toAccount);
  }

  setStatus(
    id: string,
    status: AccountStatus,
    opts: { cooldownUntil?: number; lastError?: string } = {},
  ): void {
    this.db
      .prepare("UPDATE accounts SET status = ?, cooldown_until = ?, last_error = ? WHERE id = ?")
      .run(status, status === "cooldown" ? (opts.cooldownUntil ?? null) : null, opts.lastError ?? null, id);
  }

  /**
   * Records why the quota summary could not be read, or clears it. Kept apart from
   * `lastError`: this is a diagnostics note about a read, not a state the account is in,
   * and the account stays as eligible as it was (spec §11).
   */
  setQuotaSummaryError(id: string, error: string | null): void {
    this.db.prepare("UPDATE accounts SET quota_summary_error = ? WHERE id = ?").run(error, id);
  }

  /**
   * Stores the account's tier, both halves (spec D15): the id is the stable
   * discriminator a caller can branch on, the name is the label a person reads.
   *
   * Writes what it is given, nulls included. Preserving a previous tier when a read
   * fails is the caller's decision, not a setter's (spec §13).
   */
  setPaidTier(id: string, tier: { id: string | null; name: string | null }): void {
    this.db
      .prepare("UPDATE accounts SET paid_tier_id = ?, paid_tier_name = ? WHERE id = ?")
      .run(tier.id, tier.name, id);
  }

  setTokens(id: string, tokens: { accessToken: string; accessExpiresAt: number }): void {
    this.db
      .prepare("UPDATE accounts SET access_token = ?, access_expires_at = ? WHERE id = ?")
      .run(tokens.accessToken, tokens.accessExpiresAt, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE accounts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  setPriority(id: string, priority: number): void {
    this.db.prepare("UPDATE accounts SET priority = ? WHERE id = ?").run(priority, id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE accounts SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  removeAccount(id: string): void {
    this.db.prepare("DELETE FROM quota_snapshots WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  /**
   * Sets the account's quota to exactly these rows, replacing whatever was there.
   * An empty list clears the snapshot, which is what a failed read must produce:
   * the reading is "as of fetchedAt", and a lingering row would contradict the
   * account's reported state (spec §11).
   */
  replaceQuota(accountId: string, rows: Array<Omit<QuotaBucket, "accountId">>): void {
    this.db.prepare("DELETE FROM quota_snapshots WHERE account_id = ?").run(accountId);
    const insert = this.db.prepare(
      `INSERT INTO quota_snapshots
         (account_id, bucket_id, window, display_name, group_name, group_description,
          bucket_description, remaining_fraction, reset_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        accountId,
        row.bucketId,
        row.window,
        row.displayName,
        row.groupName,
        row.groupDescription,
        row.bucketDescription,
        row.remainingFraction,
        row.resetAt,
        row.fetchedAt,
      );
    }
  }

  getQuota(accountId: string): QuotaBucket[] {
    const rows = this.db
      .prepare("SELECT * FROM quota_snapshots WHERE account_id = ?")
      .all(accountId) as unknown as Array<{
      account_id: string;
      bucket_id: string;
      window: string;
      display_name: string | null;
      group_name: string | null;
      group_description: string | null;
      bucket_description: string | null;
      remaining_fraction: number;
      reset_at: number | null;
      fetched_at: number;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      bucketId: row.bucket_id,
      window: row.window,
      displayName: row.display_name,
      groupName: row.group_name,
      groupDescription: row.group_description,
      bucketDescription: row.bucket_description,
      remainingFraction: row.remaining_fraction,
      resetAt: row.reset_at,
      fetchedAt: row.fetched_at,
    }));
  }

  snapshot(): AccountSnapshot[] {
    return this.listAccounts().map((account) => ({ ...account, quota: this.getQuota(account.id) }));
  }

  savePendingOAuth(state: string, codeVerifier: string, createdAt = Date.now()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO oauth_pending (state, code_verifier, created_at) VALUES (?, ?, ?)")
      .run(state, codeVerifier, createdAt);
  }

  /** Consumes the pending entry: once used, it cannot be used again. Expired is discarded. */
  takePendingOAuth(state: string): { verifier: string } | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_pending WHERE state = ?").get(state) as
      | { code_verifier: string; created_at: number }
      | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM oauth_pending WHERE state = ?").run(state);
    if (Date.now() - row.created_at > PENDING_OAUTH_TTL_MS) return undefined;
    return { verifier: row.code_verifier };
  }
}
