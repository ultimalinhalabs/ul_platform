import { env } from "../config/env.js";

/**
 * Structured logging foundation (Fase 16 §16) — JSON lines to stdout/stderr,
 * no external log shipper yet (that's a future, separate decision; this
 * just makes today's console.log output machine-parseable when one is
 * added). Every line carries `environment` so a shared log aggregator can
 * distinguish staging from production even though both run
 * NODE_ENV=production.
 *
 * NEVER pass: JWT/access tokens, refresh tokens, API key secrets, webhook
 * secrets, passwords, or a DATABASE_URL/connection string with embedded
 * credentials, as a field value. This module has no way to enforce that at
 * the type level — it's a discipline every call site must keep.
 */
type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  module?: string;
  event?: string;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, fields?: LogFields) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    environment: env.APP_ENV,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  /** Suppressed in production — verbose/diagnostic detail only, e.g. per-health-check pings. */
  debug(message: string, fields?: LogFields) {
    if (env.NODE_ENV !== "production") write("debug", message, fields);
  },
  info(message: string, fields?: LogFields) {
    write("info", message, fields);
  },
  warn(message: string, fields?: LogFields) {
    write("warn", message, fields);
  },
  error(message: string, fields?: LogFields) {
    write("error", message, fields);
  },
};
