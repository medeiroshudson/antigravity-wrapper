import { LeastBusyStrategy } from "./least-busy.js";
import { PaceDeficitStrategy } from "./pace-deficit.js";
import { PriorityTieredStrategy } from "./priority-tiered.js";
import { QuotaFirstStrategy } from "./quota-first.js";
import { RoundRobinStrategy } from "./round-robin.js";
import { WeightedRandomStrategy } from "./weighted-random.js";
import type { LoadBalanceStrategy, StrategyName } from "./types.js";

export interface StrategyOptions {
  respectPriority?: boolean;
}

function build(name: StrategyName): LoadBalanceStrategy {
  switch (name) {
    case "pace-deficit":
      return new PaceDeficitStrategy();
    case "quota-first":
      return new QuotaFirstStrategy();
    case "least-busy":
      return new LeastBusyStrategy();
    case "round-robin":
      return new RoundRobinStrategy();
    case "weighted-random":
      return new WeightedRandomStrategy();
  }
}

/** Builds a strategy by name; explicit priority is honoured unless the caller opts out. */
export function createStrategy(name: StrategyName, options: StrategyOptions = {}): LoadBalanceStrategy {
  const strategy = build(name);
  return options.respectPriority === false ? strategy : new PriorityTieredStrategy(strategy);
}
