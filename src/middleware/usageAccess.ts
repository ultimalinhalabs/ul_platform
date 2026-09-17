import type { NextFunction, Request, Response } from "express";
import { findActiveMembership } from "../modules/memberships/service.js";
import { roleHasPermission } from "../modules/authorization/service.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { paramString } from "../shared/params.js";

/**
 * Dual read path for usage, same shape as `requireEntitlementAccess`:
 * a service credential is authorized by its own stored identity matching
 * the URL (plus holding `usage.read` — unlike `requireEntitlementAccess`,
 * built before service scopes existed, a usage read is additionally
 * gated by an explicit scope, not identity-match alone); a human is
 * authorized by an active Membership plus the `usage.read` permission.
 * These two paths are never merged into one check — CLAUDE.md §6/§24 keep
 * human and service authorization separate concerns throughout.
 */
export async function requireUsageReadAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    const organizationId = paramString(req.params.organizationId);
    const applicationKey = paramString(req.params.applicationKey);
    if (!organizationId || !applicationKey) {
      throw new ForbiddenError("Missing route parameters");
    }

    if (req.service) {
      if (req.service.organizationId !== organizationId) {
        throw new ForbiddenError("This credential is not scoped to this organization");
      }
      if (req.service.applicationKey !== applicationKey) {
        throw new ForbiddenError("This credential is not scoped to this application");
      }
      if (!req.service.scopes.includes("usage.read")) {
        throw new ForbiddenError("Missing service scope: usage.read");
      }
      return next();
    }

    if (!req.auth) throw new UnauthorizedError();

    const membership = await findActiveMembership(req.auth.userId, organizationId);
    if (!membership) throw new ForbiddenError("No active membership in this organization");

    const allowed = await roleHasPermission(membership.roleId, "usage.read");
    if (!allowed) throw new ForbiddenError("Missing permission: usage.read");

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
}
