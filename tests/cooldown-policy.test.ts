import { describe, expect, it } from "vitest";
import {
  COOLDOWN_POLICIES,
  cooldownDuration,
  cooldownPolicy,
} from "../src/lib/accounts/cooldown-policy.js";
import { UpstreamError } from "../src/lib/antigravity/errors.js";

describe("cooldownPolicy", () => {
  it("benches a quota wall for the family, on the first failure", () => {
    const policy = cooldownPolicy("quota");
    expect(policy).toMatchObject({ kind: "quota", scope: "family", threshold: 1 });
    // A wall nobody timed needs a conservative default: 5 minutes.
    expect(policy?.defaultMs({})).toBe(300_000);
  });

  it("benches an attributed throttle for the family, on the first failure", () => {
    const policy = cooldownPolicy("transient_rate_limit");
    expect(policy).toMatchObject({ kind: "transient_rate_limit", scope: "family", threshold: 1 });
    expect(policy?.defaultMs({})).toBe(60_000);
    // Same knob the pre-scope cooldown read, so existing tuning keeps its meaning.
    expect(policy?.defaultMs({ COOLDOWN_TRANSIENT_MS: "45000" })).toBe(45_000);
  });

  it("gives no cooldown to every other kind", () => {
    // A bad token or a block is not a wait, and a definitive refusal is the request's.
    for (const kind of [
      "auth",
      "validation_required",
      "account_blocked",
      "license",
      "model_not_found",
      "client_error",
      "server_error",
    ] as const) {
      expect(cooldownPolicy(kind)).toBeNull();
    }
  });

  it("declares exactly the benches the pool applies", () => {
    expect(COOLDOWN_POLICIES.map((policy) => policy.kind).sort()).toEqual([
      "quota",
      "transient_rate_limit",
    ]);
  });
});

describe("cooldownDuration", () => {
  it("obeys the wait the backend named", () => {
    const policy = cooldownPolicy("transient_rate_limit");
    if (!policy) throw new Error("no policy");
    const error = new UpstreamError("transient_rate_limit", 429, "slow down", 30_000);
    expect(cooldownDuration(policy, error, {})).toBe(30_000);
  });

  it("falls back to the policy default when the backend named nothing", () => {
    const policy = cooldownPolicy("quota");
    if (!policy) throw new Error("no policy");
    const error = new UpstreamError("quota", 429, "quota exceeded");
    expect(cooldownDuration(policy, error, { COOLDOWN_QUOTA_MS: "90000" })).toBe(90_000);
  });
});
