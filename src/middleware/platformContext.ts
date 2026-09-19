import type { NextFunction, Request, Response } from "express";
import { findActivePlatformAdmin } from "../modules/platformAdmins/service.js";
import { ForbiddenError } from "../shared/errors.js";

/**
 * Platform-scope counterpart of `middleware/organizationContext.ts`'s
 * `requireOrganizationMembership` — resolves and validates platform
 * authority instead of organization membership. There is no route param to
 * read (the platform is not multi-tenant the way Organizations are): the
 * authenticated user's own `req.auth.userId` IS the scoping key.
 *
 * A service credential (`req.service`) is rejected outright, never
 * silently ignored: platform administration is human-only by design
 * (CLAUDE.md §6 — human and service authentication are different
 * concerns, never conflated), so a service credential gets the same 403 a
 * human gets from `requireServiceScope` in the other direction.
 */
export function requirePlatformMembership() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        throw new ForbiddenError("Platform administration requires a human platform administrator, not a service credential");
      }

      const admin = await findActivePlatformAdmin(req.auth.userId);
      if (!admin) {
        throw new ForbiddenError("Not a platform administrator");
      }

      req.platformAdmin = {
        platformMembershipId: admin.membershipId,
        platformRoleId: admin.platformRoleId,
        platformRoleKey: admin.platformRoleKey,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}
