import { isEligibleForFamily } from "../accounts/selector.js";
import type { AccountSnapshot, QuotaBucket } from "../accounts/store.js";
import { toIsoUtc, toResetPhrase } from "./datetime.js";

export interface BucketView {
  name: string | null;
  bucketId: string;
  window: string;
  remainingPercent: number;
  remainingFraction: number;
  resetAt: string | null;
  resetsIn: string | null;
  description: string | null;
}

export interface GroupView {
  name: string;
  description: string | null;
  fetchedAt: string | null;
  buckets: BucketView[];
}

export interface WindowQuotaSummary {
  remainingPercent: number | null;
  worstRemainingPercent: number | null;
  measuredAccounts: number;
  nextResetAt: string | null;
  resetsIn: string | null;
}

export interface FamilyQuotaSummary {
  available: boolean;
  availableAccounts: number;
  observedAt: string | null;
  "5h": WindowQuotaSummary;
  weekly: WindowQuotaSummary;
}

export interface LeanPoolQuota {
  generatedAt: string;
  activeAccounts: number;
  gemini: FamilyQuotaSummary;
  claudeGpt: FamilyQuotaSummary;
}

/**
 * Assembles a lean summary of Gemini and Claude/GPT quota across the pool.
 *
 * Two questions are answered separately, because conflating them is what produced the
 * misleading number the pool used to report (spec D4). `remainingPercent` reports
 * *capacity*: the mean over every active account reporting the window, cooldown included —
 * a cooldown benches routing, not quota. `available` and `availableAccounts` report
 * *routability*, so "what the view shows" and "what the router may use" cannot drift.
 * `worstRemainingPercent` keeps the tightest account visible so a healthy mean cannot hide
 * one account about to drain.
 */
export function toLeanPoolQuota(
  accounts: readonly AccountSnapshot[],
  now: number = Date.now(),
): LeanPoolQuota {
  const active = accounts.filter((account) => {
    if (!account.enabled) return false;
    if (account.status === "invalid") return false;
    return true;
  });

  const familyBuckets = (account: AccountSnapshot, prefix: string): QuotaBucket[] =>
    account.quota.filter((row) => row.bucketId.startsWith(prefix));

  const emptyWindow = (): WindowQuotaSummary => ({
    remainingPercent: null,
    worstRemainingPercent: null,
    measuredAccounts: 0,
    nextResetAt: null,
    resetsIn: null,
  });

  /**
   * Capacity over one window. `accountsWithRows` carries each reporting account's family
   * rows, so an account counts once however many rows it reports and a window nobody
   * reports reads as unknown (`null`), never as zero.
   */
  const summarizeWindow = (
    accountsWithRows: readonly QuotaBucket[][],
    windowName: string,
  ): WindowQuotaSummary => {
    const perAccount = accountsWithRows
      .map((rows) => rows.filter((row) => row.window.toLowerCase() === windowName))
      .filter((rows) => rows.length > 0);
    const rows = perAccount.flatMap((accountRows) => accountRows);
    if (rows.length === 0) return emptyWindow();

    const fractions = rows.map((row) => row.remainingFraction);
    const mean = fractions.reduce((total, fraction) => total + fraction, 0) / fractions.length;
    const nextReset = rows.reduce<number | null>(
      (earliest, row) =>
        row.resetAt !== null && row.resetAt > now && (earliest === null || row.resetAt < earliest)
          ? row.resetAt
          : earliest,
      null,
    );

    return {
      remainingPercent: Math.round(100 * mean),
      worstRemainingPercent: Math.round(100 * Math.min(...fractions)),
      measuredAccounts: perAccount.length,
      nextResetAt: toIsoUtc(nextReset),
      resetsIn: toResetPhrase(nextReset, now),
    };
  };

  const summarizeFamily = (prefix: string): FamilyQuotaSummary => {
    const reporting = active
      .map((account) => familyBuckets(account, prefix))
      .filter((rows) => rows.length > 0);
    const rows = reporting.flatMap((accountRows) => accountRows);

    // "Measured usable capacity", unchanged from the old view: a family with no positive
    // bucket on a routable account is not available, even if the selector may still probe
    // an expired-zero or unknown-quota account for it.
    const available = active.some((account) => {
      const familyRows = familyBuckets(account, prefix);
      if (familyRows.length === 0) return false;
      const inActiveCooldown = account.status === "cooldown" && (account.cooldownUntil ?? 0) > now;
      return !inActiveCooldown && familyRows.every((row) => row.remainingFraction > 0);
    });

    return {
      available,
      availableAccounts: active.filter((account) => isEligibleForFamily(account, prefix, now))
        .length,
      // Staleness belongs to the whole family: the aggregate is only as fresh as its oldest
      // reading, even when some accounts refreshed later.
      observedAt: toIsoUtc(
        rows.length === 0 ? null : Math.min(...rows.map((row) => row.fetchedAt)),
      ),
      "5h": summarizeWindow(reporting, "5h"),
      weekly: summarizeWindow(reporting, "weekly"),
    };
  };

  return {
    generatedAt: toIsoUtc(now) ?? new Date(now).toISOString(),
    activeAccounts: active.length,
    gemini: summarizeFamily("gemini-"),
    claudeGpt: summarizeFamily("3p-"),
  };
}

/**
 * Assembles the group view the Antigravity app shows: one group per model family, one
 * bucket per window, an integer percent and the time remaining in words (spec §9).
 *
 * Pure: no I/O, and the order is the backend's throughout — groups in the order their
 * first bucket arrived, buckets in the order the backend listed them. Nothing is sorted
 * here, so a client rendering the payload shows what the app shows.
 *
 * `remainingFraction` stays beside the percentage: the integer is what a person reads,
 * the exact number is what explains a selection decision (spec §4 D7).
 */
export function toGroupsView(rows: readonly QuotaBucket[], now: number = Date.now()): GroupView[] {
  const groups = new Map<string, GroupView>();

  for (const row of rows) {
    const name = row.groupName;
    // Without a group name there is no heading to put the numbers under, and inventing
    // one would attribute the reading to a group it may not belong to.
    if (!name) continue;

    let group = groups.get(name);
    if (!group) {
      group = {
        name,
        description: row.groupDescription,
        fetchedAt: toIsoUtc(row.fetchedAt),
        buckets: [],
      };
      groups.set(name, group);
    }

    group.buckets.push({
      name: row.displayName,
      bucketId: row.bucketId,
      window: row.window,
      remainingPercent: Math.max(0, Math.min(100, Math.round(row.remainingFraction * 100))),
      remainingFraction: row.remainingFraction,
      resetAt: toIsoUtc(row.resetAt),
      resetsIn: toResetPhrase(row.resetAt, now),
      description: row.bucketDescription,
    });
  }

  return [...groups.values()];
}
