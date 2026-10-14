import { describe, expect, it } from "vitest";
import { classifyUpstream, isDefinitive } from "../src/lib/antigravity/errors.js";

describe("classifyUpstream", () => {
  it("treats a 429 with a reset hint as a quota wall, extracting retryAfterMs", () => {
    const err = classifyUpstream(429, '{"error":{"message":"Quota reached. Resets in 2h 30m."}}');
    expect(err.kind).toBe("quota");
    expect(err.retryAfterMs).toBe(9_000_000);
  });

  it("treats a 429 without a hint as transient throttling", () => {
    const err = classifyUpstream(429, '{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}');
    expect(err.kind).toBe("transient_rate_limit");
    expect(err.retryAfterMs).toBeNull();
  });

  it("treats a short reset window as transient throttling, not a wall", () => {
    const err = classifyUpstream(429, '{"error":{"message":"Quota reached. Resets in 30s."}}');
    expect(err.kind).toBe("transient_rate_limit");
  });

  it("keeps the wall and uses the long resetTime as cooldown", () => {
    const err = classifyUpstream(429, '{"error":{"message":"Quota reached. Resets in 45m."}}');
    expect(err.kind).toBe("quota");
    expect(err.retryAfterMs).toBe(2_700_000);
  });

  it("recognizes Individual quota reached as a wall", () => {
    expect(classifyUpstream(429, '{"error":{"message":"Individual quota reached."}}').kind).toBe("quota");
  });

  it("classifies 401 as auth", () => {
    expect(classifyUpstream(401, "{}").kind).toBe("auth");
  });

  it("recognizes 403 VALIDATION_REQUIRED", () => {
    expect(classifyUpstream(403, '{"error":{"details":[{"reason":"VALIDATION_REQUIRED"}]}}').kind).toBe(
      "validation_required",
    );
  });

  it("recognizes the 403 license error (missing fingerprint)", () => {
    const err = classifyUpstream(403, '{"error":{"message":"You do not have a valid license of this product."}}');
    expect(err.kind).toBe("license");
  });

  it("classifies 400 as a client error and 404 as a missing model", () => {
    expect(classifyUpstream(400, '{"error":{"message":"Invalid JSON payload"}}').kind).toBe("client_error");
    expect(classifyUpstream(404, '{"error":{"message":"Requested entity was not found"}}').kind).toBe(
      "model_not_found",
    );
  });

  it("classifies 5xx as server_error", () => {
    expect(classifyUpstream(503, "{}").kind).toBe("server_error");
  });

  it("does not leak the token in the message", () => {
    const err = classifyUpstream(401, '{"error":{"message":"bad token ya29.SYNTHETICVALUE000"}}');
    expect(err.message).not.toContain("ya29.SYNTHETIC");
  });
});

describe("isDefinitive", () => {
  it("calls the request-level failures definitive", () => {
    // No other endpoint or account can repair these: the request itself is wrong.
    expect(isDefinitive("model_not_found")).toBe(true);
    expect(isDefinitive("client_error")).toBe(true);
    expect(isDefinitive("license")).toBe(true);
  });

  it("leaves the account-level failures repairable by another account", () => {
    // Each account has its own token and its own verification state, so failing over is
    // a real remedy and must keep working.
    expect(isDefinitive("auth")).toBe(false);
    expect(isDefinitive("validation_required")).toBe(false);
    expect(isDefinitive("quota")).toBe(false);
    expect(isDefinitive("transient_rate_limit")).toBe(false);
    expect(isDefinitive("server_error")).toBe(false);
  });
});
