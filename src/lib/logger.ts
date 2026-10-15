export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Discards everything. Default for direct construction (tests, background jobs). */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
