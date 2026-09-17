import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../shared/errors.js";

/**
 * Gates a service-authenticated operation behind a specific granted scope —
 * the machine-identity equivalent of `requirePermission`. Must run after
 * `authenticate`. A human credential (`req.auth`/`req.membership`) can never
 * satisfy this — CLAUDE.md is explicit that human and service authorization
 * are different concerns and must not be conflated; there is no fallback
 * that checks a Permission instead.
 *
 * Scopes come from `req.service.scopes`, populated once by `verifyApiKeyToken`
 * from the persisted `api_key_scopes` grant — never re-read from the request
 * itself, so nothing a caller sends can widen what its own credential holds.
 */
export function requireServiceScope(scopeKey: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.service) {
      return next(new ForbiddenError("This operation requires a service credential"));
    }
    if (!req.service.scopes.includes(scopeKey)) {
      return next(new ForbiddenError(`Missing service scope: ${scopeKey}`));
    }
    next();
  };
}
