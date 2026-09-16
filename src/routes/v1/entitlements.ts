import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { getEffectiveEntitlement, getEffectiveEntitlements } from "../../modules/entitlements/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * `entitlement.read` (existing permission, already granted to
 * OWNER/ADMIN/MANAGER, not STAFF) — distinct from `subscription.read`
 * used by .../applications: this endpoint answers "what capability
 * values does our subscription resolve to", not "what subscriptions do
 * we have". See README's Permission vs Entitlement section.
 */
export const entitlementsRouter = Router();

entitlementsRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/entitlements",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("entitlement.read"),
  asyncHandler(async (req, res) => {
    const resolved = await getEffectiveEntitlements(
      req.membership!.organizationId,
      paramString(req.params.applicationKey)!,
    );
    ok(res, resolved);
  }),
);

entitlementsRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/entitlements/:key",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("entitlement.read"),
  asyncHandler(async (req, res) => {
    const resolved = await getEffectiveEntitlement(
      req.membership!.organizationId,
      paramString(req.params.applicationKey)!,
      paramString(req.params.key)!,
    );
    ok(res, resolved);
  }),
);
