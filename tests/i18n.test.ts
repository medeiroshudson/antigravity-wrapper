import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGE_KEYS,
  getLocale,
  resetLocaleForTests,
  resolveLocale,
  setLocale,
  t,
} from "../src/i18n/index.js";

afterEach(() => {
  resetLocaleForTests();
});

describe("resolveLocale", () => {
  it("defaults to en-US when unset or blank", () => {
    expect(resolveLocale({})).toBe("en-US");
    expect(resolveLocale({ APP_LOCALE: "" })).toBe("en-US");
    expect(resolveLocale({ APP_LOCALE: "   " })).toBe("en-US");
  });

  it("accepts a known locale case-insensitively", () => {
    expect(resolveLocale({ APP_LOCALE: "en-US" })).toBe("en-US");
    expect(resolveLocale({ APP_LOCALE: "EN-us" })).toBe("en-US");
  });

  it("falls back to the default for an unknown locale instead of failing", () => {
    expect(resolveLocale({ APP_LOCALE: "pt-BR" })).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ APP_LOCALE: "xx" })).toBe(DEFAULT_LOCALE);
  });
});

describe("t", () => {
  it("renders a catalog entry", () => {
    expect(t("config.apiKeyMissing")).toBe("API_KEY must be configured");
  });

  it("interpolates named parameters", () => {
    expect(t("chat.modelNotFound", { model: "nope" })).toBe("Model 'nope' not found");
    expect(t("upstream.noHeaders", { ms: 180000 })).toBe(
      "upstream did not send headers within 180000ms",
    );
  });

  it("interpolates every occurrence of a repeated placeholder", () => {
    expect(t("oauth.tokenExchangeFailed", { status: 400, detail: "bad" })).toBe(
      "Token exchange failed (400): bad",
    );
  });

  it("leaves an unfilled placeholder visible rather than rendering an empty gap", () => {
    expect(t("chat.modelNotFound")).toContain("{model}");
    expect(t("oauth.tokenExchangeFailed", { status: 400 })).toContain("{detail}");
  });
});

describe("catalog", () => {
  it("ships the default locale", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("renders a non-empty string for every key", () => {
    // Every message a caller can receive renders text, whatever the locale.
    for (const key of MESSAGE_KEYS) {
      expect(t(key).trim().length, key).toBeGreaterThan(0);
    }
  });

  it("uses only ASCII in the default catalog", () => {
    // Avoids mojibake in terminals and HTTP clients that mis-handle non-UTF-8.
    for (const key of MESSAGE_KEYS) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7E]*$/.test(t(key)), `${key}: ${t(key)}`).toBe(true);
    }
  });
});

describe("locale state", () => {
  it("exposes the active locale and resets to the default", () => {
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    setLocale("en-US");
    expect(getLocale()).toBe("en-US");
    resetLocaleForTests();
    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });
});
