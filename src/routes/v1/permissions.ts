import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getPermissionByKey, listPermissions } from "../../modules/permissions/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/** See roles.ts for why this is a top-level, authenticate-only route. */
export const permissionsRouter = Router();

permissionsRouter.get(
  "/permissions",
  authenticate,
  asyncHandler(async (_req, res) => {
    ok(res, await listPermissions());
  }),
);

permissionsRouter.get(
  "/permissions/:permissionKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const permission = await getPermissionByKey(paramString(req.params.permissionKey)!);
    ok(res, permission);
  }),
);
