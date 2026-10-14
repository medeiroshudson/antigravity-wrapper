import { describe, expect, it } from "vitest";
import { toIsoUtc, toResetPhrase } from "../src/lib/format/datetime.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("toIsoUtc", () => {
  it("renders an epoch as ISO 8601 in UTC with a Z offset", () => {
    expect(toIsoUtc(Date.parse("2026-10-19T20:43:54Z"))).toBe("2026-10-19T20:43:54Z");
  });

  it("round-trips the backend's own ISO string unchanged", () => {
    // resetTime arrives from the summary RPC already in this exact form; storing it as
    // epoch and rendering it back must not add or lose precision.
    const fromBackend = "2026-10-14T03:07:40Z";
    expect(toIsoUtc(Date.parse(fromBackend))).toBe(fromBackend);
  });

  it("returns null for null, undefined and non-finite input", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc(Number.NaN)).toBeNull();
    expect(toIsoUtc(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("renders epoch zero rather than treating it as absent", () => {
    expect(toIsoUtc(0)).toBe("1970-01-01T00:00:00Z");
  });
});

describe("toResetPhrase", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");

  it("returns null when there is no date", () => {
    expect(toResetPhrase(null, now)).toBeNull();
    expect(toResetPhrase(undefined, now)).toBeNull();
  });

  it("returns 'now' for a date already passed", () => {
    expect(toResetPhrase(now - HOUR, now)).toBe("now");
  });

  it("returns 'now' under a minute", () => {
    expect(toResetPhrase(now + 59_000, now)).toBe("now");
  });

  it("returns minutes under an hour", () => {
    expect(toResetPhrase(now + 45 * MINUTE, now)).toBe("45m");
  });

  it("returns hours and minutes from an hour up", () => {
    expect(toResetPhrase(now + 4 * HOUR + 9 * MINUTE, now)).toBe("4h 9m");
  });

  it("returns days and hours from a day up", () => {
    expect(toResetPhrase(now + 5 * DAY + 21 * HOUR, now)).toBe("5d 21h");
  });

  it("drops the zero remainder instead of padding it", () => {
    expect(toResetPhrase(now + 2 * HOUR, now)).toBe("2h 0m");
    expect(toResetPhrase(now + 3 * DAY, now)).toBe("3d 0h");
  });
});
