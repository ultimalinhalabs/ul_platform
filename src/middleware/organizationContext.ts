import type { NextFunction, Request, Response } from "express";
import { findActiveMembership } from "../modules/memberships/service.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";

/**
 * Resolves and validates the Organization context for a request from a
 * route param (never from a client-supplied header/body field): the
 * authenticated user must hold an active Membership in that organization.
 * Attaches `req.membership`; does not check any specific permission.
 */
export function requireOrganizationMembership(paramName = "organizationId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        throw new UnauthorizedError();
      }

      const rawParam = req.params[paramName];
      const organizationId = Array.isArray(rawParam) ? rawParam[0] : rawParam;
      if (!organizationId) {
        throw new ForbiddenError(`Missing :${paramName} route parameter`);
      }

      const membership = await findActiveMembership(req.auth.userId, organizationId);
      if (!membership) {
        throw new ForbiddenError("No active membership in this organization");
      }

      req.membership = {
        organizationId,
        membershipId: membership.membershipId,
        roleId: membership.roleId,
        roleKey: membership.roleKey,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}
