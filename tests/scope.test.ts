import { describe, expect, it } from "vitest";
import { failureScope, refusalKey } from "../src/lib/antigravity/scope.js";
import { UpstreamError, type UpstreamFailureKind } from "../src/lib/antigravity/errors.js";

function errorOf(
  kind: UpstreamFailureKind,
  status = 429,
  message = "x",
  retryAfterMs: number | null = null,
): UpstreamError {
  return new UpstreamError(kind, status, message, retryAfterMs);
}

describe("failureScope", () => {
  it("does not charge the account for verdicts any account would repeat", () => {
    // Measured 2026-11-15: one literal in the system instruction answered 429 on every
    // account. Charging each of them parked three healthy accounts per request.
    for (const kind of ["model_not_found", "client_error", "license"] as const) {
      expect(failureScope(errorOf(kind))).toBe("request");
    }
  });

  it("treats a channel failure as not the account's", () => {
    expect(failureScope(errorOf("server_error", 503))).toBe("request");
  });

  it("charges the account for failures that are about its own state", () => {
    for (const kind of ["auth", "validation_required", "account_blocked", "quota"] as const) {
      expect(failureScope(errorOf(kind))).toBe("account");
    }
  });

  it("charges the account for a throttle the backend attributed a wait to", () => {
    // With a reset hint the backend named this account's own wait, so retrying elsewhere
    // would only hide it: the account is what has to stop.
    expect(failureScope(errorOf("transient_rate_limit", 429, "slow down", 30_000))).toBe("account");
  });

  it("leaves an unattributed throttle to the request", () => {
    // Without a hint the same body answers for every account (measured 2026-11-15), so
    // there is nothing account-shaped to charge.
    expect(failureScope(errorOf("transient_rate_limit", 429, "Resource has been exhausted"))).toBe(
      "request",
    );
  });
});

describe("refusalKey", () => {
  it("is identical for the same refusal, and differs when any part differs", () => {
    const base = errorOf("transient_rate_limit", 429, "Resource has been exhausted (e.g. check quota).");
    expect(refusalKey(base)).toBe(refusalKey(errorOf("transient_rate_limit", 429, base.message)));
    expect(refusalKey(base)).not.toBe(refusalKey(errorOf("transient_rate_limit", 429, "Quota reached.")));
    expect(refusalKey(base)).not.toBe(refusalKey(errorOf("server_error", 503, base.message)));
  });
});
