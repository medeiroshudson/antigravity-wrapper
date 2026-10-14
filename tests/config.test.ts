import { describe, expect, it } from "vitest";
import {
  assertSafeBaseUrl,
  endpointCandidates,
  getLogLevel,
  getMaxFailoverAttempts,
  getUserAgent,
  maskEmail,
  redact,
  resolveApiKey,
} from "../src/config/index.js";

describe("getLogLevel", () => {
  it("accepts every level the logger understands", () => {
    for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) {
      expect(getLogLevel({ LOG_LEVEL: level })).toBe(level);
    }
  });

  it("matches case-insensitively, as the locale does", () => {
    expect(getLogLevel({ LOG_LEVEL: "DEBUG" })).toBe("debug");
    expect(getLogLevel({ LOG_LEVEL: "  Warn  " })).toBe("warn");
  });

  it("falls back to info when unset or unrecognised", () => {
    // A typo must not take the service down: the boot is not the place to discover that
    // someone wrote `verbose`.
    expect(getLogLevel({})).toBe("info");
    expect(getLogLevel({ LOG_LEVEL: "" })).toBe("info");
    expect(getLogLevel({ LOG_LEVEL: "   " })).toBe("info");
    expect(getLogLevel({ LOG_LEVEL: "verbose" })).toBe("info");
  });
});

describe("resolveApiKey", () => {
  it("fails closed when absent or empty", () => {
    expect(() => resolveApiKey({})).toThrow("API_KEY must be configured");
    expect(() => resolveApiKey({ API_KEY: "" })).toThrow("API_KEY must be configured");
  });

  it.each([" leading", "trailing ", "internal whitespace", "comma,key"])(
    "rejects invalid Bearer characters: %j",
    (value) => {
      expect(() => resolveApiKey({ API_KEY: value })).toThrow("API_KEY must be a valid Bearer token");
    },
  );

  it("accepts a normal key", () => {
    expect(resolveApiKey({ API_KEY: "sk-local-abc" })).toBe("sk-local-abc");
  });
});

describe("assertSafeBaseUrl", () => {
  it("rejects a host outside googleapis.com", () => {
    expect(() => assertSafeBaseUrl("https://evil.example.com")).toThrow("is not allowed");
  });

  it("rejects http and embedded credentials", () => {
    expect(() => assertSafeBaseUrl("http://x.googleapis.com")).toThrow("https");
    expect(() => assertSafeBaseUrl("https://u:p@x.googleapis.com")).toThrow("must not include credentials");
  });

  it("accepts and normalizes an allowed host", () => {
    expect(assertSafeBaseUrl("https://daily-cloudcode-pa.googleapis.com/")).toBe(
      "https://daily-cloudcode-pa.googleapis.com",
    );
  });
});

describe("endpointCandidates", () => {
  it("returns the three endpoints in the documented default order", () => {
    expect(endpointCandidates({})).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
    ]);
  });

  it("uses the validated override when present", () => {
    expect(endpointCandidates({ ANTIGRAVITY_BASE_URL: "https://cloudcode-pa.googleapis.com" })).toEqual([
      "https://cloudcode-pa.googleapis.com",
    ]);
  });
});

describe("numeric values", () => {
  it("uses the default when absent and the value when valid", () => {
    expect(getMaxFailoverAttempts({})).toBe(3);
    expect(getMaxFailoverAttempts({ MAX_FAILOVER_ATTEMPTS: "5" })).toBe(5);
    expect(getMaxFailoverAttempts({ MAX_FAILOVER_ATTEMPTS: "zero" })).toBe(3);
    expect(getMaxFailoverAttempts({ MAX_FAILOVER_ATTEMPTS: "0" })).toBe(3);
  });
});

describe("getUserAgent", () => {
  it("returns the CLI fingerprint by default", () => {
    expect(getUserAgent({})).toBe(
      "antigravity/cli/1.2.4 (aidev_client; os_type=linux; armd64; cl=982146307; auth_method=consumer)",
    );
  });

  it("honors the override", () => {
    expect(getUserAgent({ ANTIGRAVITY_USER_AGENT: "custom/1" })).toBe("custom/1");
  });
});

describe("redact", () => {
  it("removes access and refresh tokens", () => {
    const input =
      'access_token: "ya29.SYNTHETICVALUE000" refresh_token: 1//SYNTHETICREFRESH Authorization: Bearer ya29.SYNTHETICVALUE111';
    const out = redact(input);
    expect(out).not.toContain("ya29.SYNTHETIC");
    expect(out).not.toContain("1//SYNTHETICREFRESH");
  });

  it("redacts a bare refresh token without a key: value context", () => {
    const twoSlash = `1//${"A".repeat(30)}`;
    const oneSlash = `1/${"A".repeat(30)}`;
    expect(redact(twoSlash)).not.toContain("1//");
    expect(redact(oneSlash)).not.toContain("1/");
    expect(redact(`leaked ${twoSlash} end`)).not.toContain("1//");
    expect(redact(`?refresh=${twoSlash}`)).not.toContain("1//");
  });
});

describe("maskEmail", () => {
  it("masks the name and preserves the domain", () => {
    expect(maskEmail("hudson@gmail.com")).toBe("h***n@gmail.com");
    expect(maskEmail(undefined)).toBeUndefined();
  });
});
