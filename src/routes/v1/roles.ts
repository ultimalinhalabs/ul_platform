import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getRoleDetail, listRoles } from "../../modules/roles/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Roles are global platform catalog, not per-organization data (see
 * CLAUDE.md §2 "global roles + global permissions" for v1) — so these
 * live at the top level, not nested under /organizations/:id. Read access
 * only requires authentication: the catalog is non-sensitive structural
 * metadata about the authorization model, not tenant data. There's no
 * PLATFORM_ADMIN actor yet to gate it more tightly with (deferred until
 * the Console phase — see README "Platform vs Organization administration").
 */
export const rolesRouter = Router();

rolesRouter.get(
  "/roles",
  authenticate,
  asyncHandler(async (_req, res) => {
    ok(res, await listRoles());
  }),
);

rolesRouter.get(
  "/roles/:roleKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const detail = await getRoleDetail(paramString(req.params.roleKey)!);
    ok(res, detail);
  }),
);
