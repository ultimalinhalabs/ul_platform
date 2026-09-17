import type { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { paramString } from "../shared/params.js";

/**
 * Gates a service-only, application-scoped operation (e.g. recording usage
 * — see routes/v1/usage.ts) to the credential's own stored application.
 * Sibling of `requireServiceOrganizationMatch`, same reasoning: a NA_PISTA
 * credential must never be usable to write/read MICHA_EXPRESS's usage
 * merely because the URL says so — `applicationKey` is read only from the
 * credential row resolved during `authenticate`, never trusted from the
 * route by itself (this middleware is what enforces the two actually match).
 */
export function requireServiceApplicationMatch(paramName = "applicationKey") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.service) {
      return next(new UnauthorizedError("Service credential required"));
    }

    const applicationKey = paramString(req.params[paramName]);
    if (!applicationKey) {
      return next(new ForbiddenError(`Missing :${paramName} route parameter`));
    }

    if (req.service.applicationKey !== applicationKey) {
      return next(new ForbiddenError("This credential is not scoped to this application"));
    }

    next();
  };
}
