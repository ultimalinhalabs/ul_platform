import type { NextFunction, Request, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { paramString } from "../shared/params.js";

/**
 * Gates a service-only, organization-scoped operation (e.g. publishing an
 * event — see routes/v1/events.ts) to the credential's own stored
 * organization. Deliberately service-only, unlike
 * `requireEntitlementAccess` which deliberately also accepts a human
 * fallback: an event's `source.application` must always be a real,
 * authenticated service identity — a human session is never an acceptable
 * "who published this" answer (see README "Webhooks" / CLAUDE.md §21, the
 * event source is trusted metadata, not something a human request forges).
 *
 * `organizationId` is read only from the credential row resolved during
 * `authenticate` — never from the request body — so a service can never
 * publish into an organization it wasn't issued for, no matter what the
 * route's own :organizationId claims to be (this middleware is what
 * enforces that the two actually match).
 */
export function requireServiceOrganizationMatch(paramName = "organizationId") {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.service) {
      return next(new UnauthorizedError("Service credential required"));
    }

    const organizationId = paramString(req.params[paramName]);
    if (!organizationId) {
      return next(new ForbiddenError(`Missing :${paramName} route parameter`));
    }

    if (req.service.organizationId !== organizationId) {
      return next(new ForbiddenError("This credential is not scoped to this organization"));
    }

    next();
  };
}
