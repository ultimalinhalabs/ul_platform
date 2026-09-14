import type { NextFunction, Request, Response } from "express";
import { roleHasPermission } from "../modules/authorization/service.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";

/** Must run after `requireOrganizationMembership`. */
export function requirePermission(permissionKey: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.membership) {
        throw new UnauthorizedError("Organization context not resolved");
      }

      const allowed = await roleHasPermission(req.membership.roleId, permissionKey);
      if (!allowed) {
        throw new ForbiddenError(`Missing permission: ${permissionKey}`);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
