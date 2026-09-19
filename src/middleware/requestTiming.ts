import type { NextFunction, Request, Response } from "express";
import { logger } from "../shared/logger.js";

/**
 * Logs one line per completed request — never on `req` events, only on
 * `res.on("finish")`, so it captures the real final status code including
 * ones set by errorHandler. Health-check traffic logs at `debug` (silent in
 * production, see shared/logger.ts) so polling infrastructure doesn't
 * drown real request logs at `info`.
 */
export function requestTiming(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const isHealthCheck = req.path.startsWith("/health");
    const log = isHealthCheck ? logger.debug : logger.info;

    log("request completed", {
      requestId: req.requestId,
      event: "http.request.completed",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
