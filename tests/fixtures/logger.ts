import type { Logger } from "../../src/lib/logger.js";

export interface CapturedLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  obj: Record<string, unknown>;
}

/**
 * A {@link Logger} that records every call, so a test can assert on the structured
 * fields a line carries rather than on formatted text.
 */
export function captureLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const record =
    (level: CapturedLine["level"]) =>
    (obj: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg, obj });
    };
  return {
    lines,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}
