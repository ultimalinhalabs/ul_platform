import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors.js";
import { fail } from "../shared/response.js";

/** Central error handler: predictable envelope, no leaked internals. */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload");
  }

  console.error(error);
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected server error");
}
