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
  enabled: boolean;
  priority: number;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface QuotaSnapshot {
  accountId: string;
  modelId: string;
  window: string;
  remainingFraction: number;
  resetAt: number | null;
  fetchedAt: number;
}

export type AccountSnapshot = Account & { quota: QuotaSnapshot[] };

const PENDING_OAUTH_TTL_MS = 5 * 60 * 1000;

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
        cooldown_until INTEGER, last_error TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        account_id TEXT NOT NULL, model_id TEXT NOT NULL, window TEXT NOT NULL,
        remaining_fraction REAL NOT NULL, reset_at INTEGER, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, model_id, window)
      );
      CREATE TABLE IF NOT EXISTS oauth_pending (
        state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    // Reinforcement: WAL just created the sidecars; ensure 0600 on them too.
    this.applyRestrictiveMode(dbPath);
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
           project_id = excluded.project_id, status = 'active', cooldown_until = NULL, last_error = NULL`,
      )
      .run(input.id, input.email, input.refreshToken, input.accessToken, input.accessExpiresAt, input.projectId, now);
    const account = this.getAccount(input.id);
    if (!account) throw new Error(t("account.notFoundAfterUpsert", { id: input.id }));
    return account;
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? toAccount(row) : undefined;
  }

  listAccounts(): Account[] {
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

  saveQuota(rows: QuotaSnapshot[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO quota_snapshots (account_id, model_id, window, remaining_fraction, reset_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, model_id, window) DO UPDATE SET
         remaining_fraction = excluded.remaining_fraction,
         reset_at = excluded.reset_at, fetched_at = excluded.fetched_at`,
    );
    for (const row of rows) {
      stmt.run(row.accountId, row.modelId, row.window, row.remainingFraction, row.resetAt, row.fetchedAt);
    }
  }

  getQuota(accountId: string): QuotaSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM quota_snapshots WHERE account_id = ?")
      .all(accountId) as unknown as Array<{
      account_id: string;
      model_id: string;
      window: string;
      remaining_fraction: number;
      reset_at: number | null;
      fetched_at: number;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      modelId: row.model_id,
      window: row.window,
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
