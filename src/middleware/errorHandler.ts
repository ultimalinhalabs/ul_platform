import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";
import { fail } from "../shared/response.js";

function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Central error handler: predictable envelope, no leaked internals. */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload");
  }

  // postgres.js error shape for a unique_violation — e.g. a duplicate
  // membership (user_id, organization_id) or a taken organization slug.
  if (isPostgresError(error) && error.code === "23505") {
    return fail(res, 409, "CONFLICT", "Resource already exists");
  }

  console.error(error);
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected server error");
}
