import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireEntitlementAccess } from "../../middleware/entitlementAccess.js";
import { getEffectiveEntitlement, getEffectiveEntitlements } from "../../modules/entitlements/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * The only endpoints in this API a service credential (API key) may
 * call — see middleware/entitlementAccess.ts. Humans still need an
 * active Membership + `entitlement.read` (OWNER/ADMIN/MANAGER, not
 * STAFF); a service's credential scope IS its authorization here.
 */
export const entitlementsRouter = Router();

entitlementsRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/entitlements",
  authenticate,
  requireEntitlementAccess,
  asyncHandler(async (req, res) => {
    const resolved = await getEffectiveEntitlements(
      paramString(req.params.organizationId)!,
      paramString(req.params.applicationKey)!,
    );
    ok(res, resolved);
  }),
);

entitlementsRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/entitlements/:key",
  authenticate,
  requireEntitlementAccess,
  asyncHandler(async (req, res) => {
    const resolved = await getEffectiveEntitlement(
      paramString(req.params.organizationId)!,
      paramString(req.params.applicationKey)!,
      paramString(req.params.key)!,
    );
    ok(res, resolved);
  }),
);
