import type { AccountSnapshot } from "../store.js";

export type StrategyName =
  | "pace-deficit"
  | "quota-first"
  | "least-busy"
  | "round-robin"
  | "weighted-random";

/** One account that already passed eligibility, with the numbers a strategy ranks on. */
export interface EligibleCandidate {
  account: AccountSnapshot;
  /** Lowest remaining fraction for the requested family, or `null` when unknown. */
  quota: number | null;
  /** Pace deficit for the requested family, or `null` when the window cannot be normalized. */
  score: number | null;
}

export interface SelectionContext {
  runtimeModel: string;
  bucketIdPrefix: string | null;
  now: number;
  inFlightByAccount?: ReadonlyMap<string, number>;
}

export interface LoadBalanceStrategy {
  readonly name: StrategyName;
  /** Returns every candidate, best first. Never filters: eligibility is not a strategy's job. */
  rank(candidates: readonly EligibleCandidate[], ctx: SelectionContext): AccountSnapshot[];
}
