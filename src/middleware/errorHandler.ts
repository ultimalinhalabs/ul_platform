import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, isUniqueViolationError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { fail } from "../shared/response.js";

/**
 * Central error handler: predictable envelope, no leaked internals — the
 * response body is identical in every environment (Fase 16 §15: never a
 * stack trace, SQL, or credential to the client, in staging or production
 * any more than in development). `requestId` goes in the log line and the
 * `X-Request-ID` response header (set by middleware/requestId.ts before
 * this ever runs), never in the JSON body — that would change the
 * `{data}`/`{error}` contract every existing client already relies on.
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    // A 4xx is an expected, client-caused outcome (bad input, missing
    // permission, ...) — logged at info, not error, so error-level logs
    // stay meaningful for actual server-side problems.
    logger.info("request failed", {
      requestId: req.requestId,
      event: "http.request.error",
      errorCode: error.code,
      status: error.statusCode,
      path: req.path,
    });
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    logger.info("request failed", {
      requestId: req.requestId,
      event: "http.request.error",
      errorCode: "VALIDATION_ERROR",
      status: 400,
      path: req.path,
    });
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload");
  }

  // Postgres unique_violation — e.g. a duplicate membership (user_id,
  // organization_id) or a taken organization slug. `isUniqueViolationError`
  // walks drizzle-orm's `DrizzleQueryError.cause` chain to find the
  // driver's real `PostgresError.code` — see shared/errors.ts.
  if (isUniqueViolationError(error)) {
    logger.info("request failed", {
      requestId: req.requestId,
      event: "http.request.error",
      errorCode: "CONFLICT",
      status: 409,
      path: req.path,
    });
    return fail(res, 409, "CONFLICT", "Resource already exists");
  }

  // An unexpected failure — the one case that's genuinely error-level. The
  // full error (with stack) goes only to this structured log line, keyed
  // by requestId so it can be correlated with the generic response the
  // client received; it never reaches the client itself.
  logger.error("unexpected error", {
    requestId: req.requestId,
    event: "http.request.error",
    errorCode: "INTERNAL_ERROR",
    status: 500,
    path: req.path,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected server error");
}
