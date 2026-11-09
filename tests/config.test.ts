import { describe, expect, it } from "vitest";
import {
  assertSafeBaseUrl,
  endpointCandidates,
  getBodyLimitBytes,
  getLogLevel,
  getMaxFailoverAttempts,
  getStreamFlushPatienceMs,
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

  it("parses the stream flush patience, where 0 means flush immediately", () => {
    expect(getStreamFlushPatienceMs({})).toBe(1500);
    expect(getStreamFlushPatienceMs({ STREAM_FLUSH_PATIENCE_MS: "0" })).toBe(0);
    expect(getStreamFlushPatienceMs({ STREAM_FLUSH_PATIENCE_MS: "400" })).toBe(400);
    expect(getStreamFlushPatienceMs({ STREAM_FLUSH_PATIENCE_MS: "soon" })).toBe(1500);
    expect(getStreamFlushPatienceMs({ STREAM_FLUSH_PATIENCE_MS: "-5" })).toBe(1500);
  });
});

describe("getBodyLimitBytes", () => {
  it("defaults above the Fastify 1 MiB limit that refused real agent turns", () => {
    expect(getBodyLimitBytes({})).toBe(33_554_432);
  });

  it("honours an override and ignores a non-positive value", () => {
    expect(getBodyLimitBytes({ BODY_LIMIT_BYTES: "1048576" })).toBe(1_048_576);
    expect(getBodyLimitBytes({ BODY_LIMIT_BYTES: "0" })).toBe(33_554_432);
    expect(getBodyLimitBytes({ BODY_LIMIT_BYTES: "nope" })).toBe(33_554_432);
  });
});

describe("getUserAgent", () => {
  it("builds the measured shape, in the client's own spelling", () => {
    // Captured from the installed client on 2026-11-09:
    // antigravity/cli/1.5.3 (aidev_client; os_type=darwin; arch=arm64; cl=1016078699; auth_method=consumer)
    expect(
      getUserAgent({
        ANTIGRAVITY_CLIENT_VERSION: "9.9.9",
        ANTIGRAVITY_CLIENT_BUILD: "42",
        ANTIGRAVITY_SUBCLIENT: "hub",
      }),
    ).toBe(`antigravity/hub/9.9.9 (aidev_client; os_type=${process.platform}; arch=${architecture()}; cl=42; auth_method=consumer)`);
  });

  it("reports the runtime platform and arch, not a frozen pair", () => {
    // The old constant said os_type=linux and "armd64" (a transcription of arch=arm64) on
    // every host, which no client does.
    const ua = getUserAgent({});
    expect(ua).toContain(`os_type=${process.platform}`);
    expect(ua).toContain(`arch=${architecture()}`);
    expect(ua).not.toContain("armd64");
  });

  it("honors the override", () => {
    expect(getUserAgent({ ANTIGRAVITY_USER_AGENT: "custom/1" })).toBe("custom/1");
  });
});

function architecture(): string {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "ia32") return "386";
  return process.arch;
}

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
