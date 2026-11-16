import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { t } from "../../i18n/index.js";

export type AccountStatus = "active" | "cooldown" | "invalid";

/**
 * Why an account is not serving. `status` alone cannot answer that: a TOS block, a failed
 * re-authentication and an operator disabling the account all look like "not active", and
 * before this field only `lastError` (free text) hinted at it.
 */
export type AccountStatusKind =
  | "tos_blocked"
  | "validation_required"
  | "auth"
  | "quota"
  | "rate_limited"
  | "onboarding_pending"
  | "operator_disabled";

/** The effective state, which is what an operator actually asks for. */
export type AccountState = "active" | "cooling" | "invalid" | "disabled";

/**
 * One derived answer from the three stored fields. `invalid` outranks `disabled`: an
 * upstream refusal stays the actionable fact even when the operator also parked the
 * account. A cooldown with no date has already expired (same rule the selector uses).
 */
export function accountState(account: Account, now: number = Date.now()): AccountState {
  if (account.status === "invalid") return "invalid";
  if (!account.enabled) return "disabled";
  if (account.status === "cooldown" && account.cooldownUntil !== null && account.cooldownUntil > now) {
    return "cooling";
  }
  return "active";
}

export function isUsable(account: Account, now: number = Date.now()): boolean {
  return accountState(account, now) === "active";
}

export interface Account {
  id: string;
  email: string | null;
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAt: number;
  projectId: string | null;
  status: AccountStatus;
  statusKind: AccountStatusKind | null;
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

export type AccountSnapshot = Account & { quota: QuotaBucket[]; cooldowns: CooldownRow[] };

/**
 * One bench: why (the kind), where (the family bucket prefix, or `*` for the whole
 * account) and until when. `until` 0 means the row only counts failures — the policy's
 * threshold has not been reached yet, so nothing is cooling.
 */
export interface CooldownRow {
  scope: string;
  kind: string;
  until: number;
  reason: string | null;
  failures: number;
}

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
  status_kind: string | null;
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

interface CooldownDbRow {
  account_id: string;
  scope: string;
  kind: string;
  until: number;
  reason: string | null;
  failures: number;
}

/** The admin vocabulary for a bench, derived from the failure kind that produced it. */
function statusKindOf(kind: string): AccountStatusKind | null {
  if (kind === "quota") return "quota";
  if (kind === "transient_rate_limit") return "rate_limited";
  return null;
}

/**
 * Maps a row to an `Account`, projecting the active cooldowns into `status` and
 * `cooldownUntil`.
 *
 * The `account_cooldowns` table is the one source of truth for a bench; these two columns
 * exist so every reader (the admin surface, `accountState`, the old quota views) does not
 * have to join, and they are computed here on every read — nothing writes them as state
 * any more. `invalid` still outranks a bench: a TOS block or a dead credential is the
 * actionable fact even while a family waits.
 */
function toAccount(row: Row, cooldowns: readonly CooldownRow[] = []): Account {
  const widest = cooldowns.reduce<CooldownRow | null>(
    (best, rowCooldown) =>
      best === null || rowCooldown.until > best.until ? rowCooldown : best,
    null,
  );
  const invalid = row.status === "invalid";
  // `invalid` outranks a bench: a TOS block or a dead credential is the actionable fact,
  // and its kind and reason must not be masked by a family that happens to be waiting.
  const status: AccountStatus = invalid
    ? "invalid"
    : widest !== null
      ? "cooldown"
      : row.status === "cooldown"
        ? "active"
        : (row.status as AccountStatus);
  return {
    id: row.id,
    email: row.email,
    refreshToken: row.refresh_token,
    accessToken: row.access_token,
    accessExpiresAt: row.access_expires_at,
    projectId: row.project_id,
    status,
    statusKind: invalid
      ? ((row.status_kind as AccountStatusKind | null) ?? null)
      : widest !== null
        ? statusKindOf(widest.kind)
        : ((row.status_kind as AccountStatusKind | null) ?? null),
    cooldownUntil: widest !== null ? widest.until : null,
    lastError: invalid ? row.last_error : widest !== null ? widest.reason : row.last_error,
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
        paid_tier_id TEXT, paid_tier_name TEXT, status_kind TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS oauth_pending (
        state TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_cooldowns (
        account_id TEXT NOT NULL,
        scope TEXT NOT NULL,        -- '*' = a conta inteira, ou o prefixo da família: 'gemini-', '3p-'
        kind TEXT NOT NULL,         -- o UpstreamFailureKind que produziu a espera
        until INTEGER NOT NULL,     -- 0 = só contagem de falhas, sem espera
        reason TEXT,
        failures INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (account_id, scope)
      );
    `);
    // quota_snapshots is created by the migrator, not here: the migrator's job is to
    // drop a previous shape and install the current one, in one place.
    this.migrate();
    // Additive column, independent of the destructive version step: a new column does not
    // justify re-running the quota rebuild.
    this.ensureColumns([["status_kind", "TEXT"]]);
    // After the column exists: the migration reads it to name the legacy bench's kind.
    this.migrateCooldowns();
    // Rows parked before the column existed: the only way `enabled` becomes 0 is an
    // operator action, so that is what the backfill records (and only once — afterwards
    // the kind is set and the guard skips them).
    this.db
      .prepare(
        `UPDATE accounts SET status_kind = 'operator_disabled', last_error = COALESCE(last_error, ?)
         WHERE enabled = 0 AND status_kind IS NULL`,
      )
      .run(t("account.disabledByOperator"));
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
    this.ensureColumns(added);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Moves a bench from the old account-wide columns into `account_cooldowns`.
   *
   * Unversioned on purpose: the step is idempotent (the `UPDATE` empties the source on the
   * first boot, and `INSERT OR IGNORE` covers the primary key), so it costs one statement
   * on every later start instead of a schema bump that would re-run the destructive quota
   * rebuild. The legacy `status_kind` spoke the admin vocabulary; the table speaks failure
   * kinds, so `rate_limited` becomes `transient_rate_limit` — the kind a policy knows.
   */
  private migrateCooldowns(): void {
    this.db.exec(`
      INSERT OR IGNORE INTO account_cooldowns (account_id, scope, kind, until, reason, failures)
      SELECT id, '*',
             CASE WHEN status_kind = 'rate_limited' THEN 'transient_rate_limit' ELSE 'quota' END,
             COALESCE(cooldown_until, 0), last_error, 1
      FROM accounts WHERE status = 'cooldown';
      UPDATE accounts SET status = 'active', cooldown_until = NULL,
        status_kind = CASE WHEN status_kind IN ('quota','rate_limited') THEN NULL ELSE status_kind END
      WHERE status = 'cooldown';
    `);
  }

  private ensureColumns(columns: Array<[string, string]>): void {
    for (const [column, type] of columns) {
      if (!this.hasColumn("accounts", column)) {
        // Column names are literals from this table, never caller input, so the
        // interpolation cannot be injected through.
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${type}`);
      }
    }
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
           last_error = NULL, status_kind = NULL, quota_summary_error = NULL`,
      )
      .run(input.id, input.email, input.refreshToken, input.accessToken, input.accessExpiresAt, input.projectId, now);
    // Re-login reactivates the account: a bench recorded for the previous credential must
    // not survive it, or a fresh token would arrive pre-chilled.
    this.clearCooldowns(input.id);
    const account = this.getAccount(input.id);
    if (!account) throw new Error(t("account.notFoundAfterUpsert", { id: input.id }));
    return account;
  }

  /**
   * Retires the benches whose time has passed. A cooldown with `until` 0 is a failure
   * counter, not a bench, and survives: deleting it would reset the policy's threshold on
   * every read.
   */
  expireCooldowns(now: number = Date.now()): void {
    this.db.prepare("DELETE FROM account_cooldowns WHERE until > 0 AND until <= ?").run(now);
  }

  getAccount(id: string): Account | undefined {
    const now = Date.now();
    this.expireCooldowns(now);
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? toAccount(row, this.cooldownsFor(id, now)) : undefined;
  }

  listAccounts(): Account[] {
    const now = Date.now();
    this.expireCooldowns(now);
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY priority DESC, created_at ASC")
      .all() as unknown as Row[];
    const byAccount = this.cooldowns(now);
    return rows.map((row) => toAccount(row, byAccount.get(row.id) ?? []));
  }

  /**
   * Every active bench, grouped by account: one query for a whole snapshot, so building
   * the selector's view does not become one query per account.
   */
  cooldowns(now: number = Date.now()): Map<string, CooldownRow[]> {
    this.expireCooldowns(now);
    const rows = this.db
      .prepare(
        `SELECT account_id, scope, kind, until, reason, failures
         FROM account_cooldowns WHERE until > ? ORDER BY until ASC`,
      )
      .all(now) as unknown as CooldownDbRow[];
    const grouped = new Map<string, CooldownRow[]>();
    for (const row of rows) {
      const entry: CooldownRow = {
        scope: row.scope,
        kind: row.kind,
        until: row.until,
        reason: row.reason,
        failures: row.failures,
      };
      const list = grouped.get(row.account_id);
      if (list) list.push(entry);
      else grouped.set(row.account_id, [entry]);
    }
    return grouped;
  }

  /** The active benches of one account, which is what the admin view lists. */
  cooldownsFor(accountId: string, now: number = Date.now()): CooldownRow[] {
    return this.cooldowns(now).get(accountId) ?? [];
  }

  /**
   * The streak of failures recorded for (account, scope), bench or not. The service reads
   * it before writing so one failure counts once and the policy's threshold can ask how
   * many came before.
   */
  failureStreak(accountId: string, scope: string): number {
    const row = this.db
      .prepare("SELECT failures FROM account_cooldowns WHERE account_id = ? AND scope = ?")
      .get(accountId, scope) as { failures: number } | undefined;
    return row?.failures ?? 0;
  }

  /**
   * Records one failure for (account, scope) and returns the new count. `until` null only
   * counts: the policy's threshold has not been reached, so nothing cools yet. An existing
   * bench is never shortened by a count-only write.
   */
  recordFailure(
    accountId: string,
    input: { scope: string; kind: string; until: number | null; reason: string | null },
  ): number {
    this.db
      .prepare(
        `INSERT INTO account_cooldowns (account_id, scope, kind, until, reason, failures)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(account_id, scope) DO UPDATE SET
           kind = CASE
             WHEN excluded.until = 0 AND account_cooldowns.until > 0 THEN account_cooldowns.kind
             WHEN account_cooldowns.kind = 'quota' AND excluded.kind != 'quota' AND account_cooldowns.until >= excluded.until THEN account_cooldowns.kind
             ELSE excluded.kind
           END,
           reason = CASE
             WHEN excluded.until = 0 AND account_cooldowns.until > 0 THEN account_cooldowns.reason
             WHEN account_cooldowns.kind = 'quota' AND excluded.kind != 'quota' AND account_cooldowns.until >= excluded.until THEN account_cooldowns.reason
             WHEN excluded.until < account_cooldowns.until AND account_cooldowns.until > 0 THEN account_cooldowns.reason
             ELSE COALESCE(excluded.reason, account_cooldowns.reason)
           END,
           until = MAX(account_cooldowns.until, excluded.until),
           failures = account_cooldowns.failures + 1`,
      )
      .run(accountId, input.scope, input.kind, input.until ?? 0, input.reason);
    const row = this.db
      .prepare("SELECT failures, reason FROM account_cooldowns WHERE account_id = ? AND scope = ?")
      .get(accountId, input.scope) as { failures: number; reason: string | null } | undefined;
    if (row?.reason !== undefined && row.reason !== null) {
      // The row is deleted when the bench expires, but the reason is why the account was
      // parked at all: keeping it on the account is what leaves history after the row goes.
      this.db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(row.reason, accountId);
    }
    return row?.failures ?? 1;
  }

  /** Deletes one scope's bench, or every bench of the account when `scope` is omitted. */
  clearCooldowns(accountId: string, scope?: string): void {
    if (scope === undefined) {
      this.db.prepare("DELETE FROM account_cooldowns WHERE account_id = ?").run(accountId);
      return;
    }
    this.db
      .prepare("DELETE FROM account_cooldowns WHERE account_id = ? AND scope = ?")
      .run(accountId, scope);
  }

  setStatus(
    id: string,
    status: AccountStatus,
    opts: {
      cooldownUntil?: number;
      lastError?: string;
      statusKind?: AccountStatusKind | null;
    } = {},
  ): void {
    if (status === "cooldown") {
      // The table is the source of truth: parking the account writes the bench there and
      // leaves the columns for `toAccount` to project.
      this.db
        .prepare(
          `INSERT INTO account_cooldowns (account_id, scope, kind, until, reason, failures)
           VALUES (?, '*', ?, ?, ?, 1)
           ON CONFLICT(account_id, scope) DO UPDATE SET
             kind = excluded.kind, until = excluded.until, reason = excluded.reason`,
        )
        .run(
          id,
          opts.statusKind === "rate_limited" ? "transient_rate_limit" : "quota",
          opts.cooldownUntil ?? 0,
          opts.lastError ?? null,
        );
      this.db
        .prepare("UPDATE accounts SET status = 'active', cooldown_until = NULL, status_kind = NULL, last_error = ? WHERE id = ?")
        .run(opts.lastError ?? null, id);
      return;
    }
    // Any other verdict ends the account-wide bench: it either replaces the reason or
    // releases the account, and a stale row would keep projecting `cooldown` over it.
    this.clearCooldowns(id);
    this.db
      .prepare("UPDATE accounts SET status = ?, cooldown_until = NULL, last_error = ?, status_kind = ? WHERE id = ?")
      .run(status, opts.lastError ?? null, opts.statusKind ?? null, id);
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

  /**
   * Records a completed onboarding as one write: the assigned project, both tier fields,
   * and the state that being provisioned implies. One statement so a resumed account never
   * reads as half-provisioned; clearing `status_kind` and `last_error` is what lets a
   * re-onboarded account leave a recorded block behind (spec D7).
   */
  markOnboarded(
    id: string,
    input: { projectId: string; paidTierId: string | null; paidTierName: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE accounts SET project_id = ?, paid_tier_id = ?, paid_tier_name = ?,
           status = 'active', status_kind = NULL, cooldown_until = NULL, last_error = NULL
         WHERE id = ?`,
      )
      .run(input.projectId, input.paidTierId, input.paidTierName, id);
    // Provisioning is a new fact about the account; the bench it was carrying was about
    // the unprovisioned one.
    this.clearCooldowns(id);
  }

  setTokens(id: string, tokens: { accessToken: string; accessExpiresAt: number }): void {
    this.db
      .prepare("UPDATE accounts SET access_token = ?, access_expires_at = ? WHERE id = ?")
      .run(tokens.accessToken, tokens.accessExpiresAt, id);
  }

  /**
   * Parks or releases the account. Disabling records why (the listing used to show
   * `enabled=false` with no reason at all); enabling clears that note but never an
   * upstream verdict — a TOS block stays recorded while the operator decides.
   */
  setEnabled(id: string, enabled: boolean): void {
    if (!enabled) {
      this.db
        .prepare(
          `UPDATE accounts SET enabled = 0,
             status_kind = COALESCE(status_kind, 'operator_disabled'),
             last_error = COALESCE(last_error, ?)
           WHERE id = ?`,
        )
        .run(t("account.disabledByOperator"), id);
      return;
    }
    this.db
      .prepare(
        `UPDATE accounts SET enabled = 1,
           status_kind = CASE WHEN status_kind = 'operator_disabled' THEN NULL ELSE status_kind END,
           last_error = CASE WHEN status_kind = 'operator_disabled' THEN NULL ELSE last_error END
         WHERE id = ?`,
      )
      .run(id);
  }

  setPriority(id: string, priority: number): void {
    this.db.prepare("UPDATE accounts SET priority = ? WHERE id = ?").run(priority, id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE accounts SET last_used_at = ?, last_error = NULL WHERE id = ?").run(Date.now(), id);
  }

  removeAccount(id: string): void {
    this.db.prepare("DELETE FROM quota_snapshots WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM account_cooldowns WHERE account_id = ?").run(id);
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

  /**
   * Reads the account's bucket rows in the order they were inserted, which is the order
   * the backend reported them (spec D6). The `(account_id, bucket_id)` primary-key index
   * serves the `account_id` predicate, so without an explicit `ORDER BY` SQLite returns
   * the rows alphabetically by `bucket_id` and the promised order is lost. `replaceQuota`
   * deletes and re-inserts the account's rows in backend order, so `rowid` order is
   * insertion order.
   */
  getQuota(accountId: string): QuotaBucket[] {
    const rows = this.db
      .prepare("SELECT * FROM quota_snapshots WHERE account_id = ? ORDER BY rowid")
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
    const now = Date.now();
    const cooldowns = this.cooldowns(now);
    return this.listAccounts().map((account) => ({
      ...account,
      quota: this.getQuota(account.id),
      cooldowns: cooldowns.get(account.id) ?? [],
    }));
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
