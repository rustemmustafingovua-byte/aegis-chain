/**
 * AEGIS Logger v1.10 — structured JSON logs to stderr (prod friendly)
 * Levels: debug < info < warn < error. Configure via AEGIS_LOG_LEVEL.
 * Existing console.log call-sites migrate to logger.info/warn/error.
 */
import { CONFIG } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  const min = RANK[CONFIG.logLevel] ?? 1;
  if (RANK[level] < min) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
