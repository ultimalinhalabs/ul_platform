import type { NextFunction, Request, Response } from "express";
import { platformRoleHasPermission } from "../modules/platformAuthorization/service.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";

/** Must run after `requirePlatformMembership` — the platform-scope counterpart of `middleware/requirePermission.ts`. */
export function requirePlatformPermission(permissionKey: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.platformAdmin) {
        throw new UnauthorizedError("Platform context not resolved");
      }

      const allowed = await platformRoleHasPermission(req.platformAdmin.platformRoleId, permissionKey);
      if (!allowed) {
        throw new ForbiddenError(`Missing platform permission: ${permissionKey}`);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
