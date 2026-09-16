import type { NextFunction, Request, Response } from "express";
import { findActiveMembership } from "../modules/memberships/service.js";
import { roleHasPermission } from "../modules/authorization/service.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { paramString } from "../shared/params.js";

/**
 * The one deliberately-opened service-to-service read path (see README
 * "API Keys" / "Service-to-service use case"): a service credential may
 * read Effective Entitlements for the organization+application it is
 * itself scoped to — exactly the "NA_PISTA checks its own org's
 * entitlements" use case, nothing broader.
 *
 * Two entirely different resolution paths, not one generic middleware
 * bent to fit both: a human needs an active Membership *and*
 * `entitlement.read`; a service has no membership at all — its stored
 * (never client-supplied) organizationId/applicationId match against
 * the route *is* the authorization, since this credential can only ever
 * have been minted for that one organization+application pair. Forcing
 * this into `requireOrganizationMembership`/`requirePermission` would
 * require inventing a fake membership for a service, which CLAUDE.md
 * explicitly rules out.
 */
export async function requireEntitlementAccess(req: Request, _res: Response, next: NextFunction) {
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
      return next();
    }

    if (!req.auth) throw new UnauthorizedError();

    const membership = await findActiveMembership(req.auth.userId, organizationId);
    if (!membership) throw new ForbiddenError("No active membership in this organization");

    const allowed = await roleHasPermission(membership.roleId, "entitlement.read");
    if (!allowed) throw new ForbiddenError("Missing permission: entitlement.read");

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
