import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, isUniqueViolationError } from "../shared/errors.js";
import { fail } from "../shared/response.js";

/** Central error handler: predictable envelope, no leaked internals. */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload");
  }

  // Postgres unique_violation — e.g. a duplicate membership (user_id,
  // organization_id) or a taken organization slug. `isUniqueViolationError`
  // walks drizzle-orm's `DrizzleQueryError.cause` chain to find the
  // driver's real `PostgresError.code` — see shared/errors.ts.
  if (isUniqueViolationError(error)) {
    return fail(res, 409, "CONFLICT", "Resource already exists");
  }

  console.error(error);
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected server error");
}
