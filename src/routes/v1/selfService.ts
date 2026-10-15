import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { idempotencyKeySchema } from "../../modules/commercial/schemas.js";
import {
  configurePlanCommercial,
  configurePlanCommercialSchema,
  listSelfServiceCatalog,
  startSelfServiceContracting,
  startSelfServiceSchema,
} from "../../modules/commercial/selfService.service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ValidationError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Migration 0024 — self-service contracting (modules/commercial/selfService.service.ts).
 *  - GET  /catalog/self-service                         any signed-in person: the offer, as UL configured it.
 *  - PUT  /platform/plans/:applicationKey/:planKey/commercial   platform admin (`platform.proposal.manage`).
 *  - POST /organizations/:organizationId/self-service/contracts OWNER of the active organization, verified
 *         email, Idempotency-Key; returns the frozen offer to accept via POST /proposals/:id/acceptance.
 */
export const selfServiceRouter = Router();

selfServiceRouter.get(
  "/catalog/self-service",
  authenticate,
  asyncHandler(async (req, res) => {
    const applicationKey = z.string().min(1).max(100).optional().parse(req.query.applicationKey);
    ok(res, await listSelfServiceCatalog(applicationKey));
  }),
);

selfServiceRouter.put(
  "/platform/plans/:applicationKey/:planKey/commercial",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.proposal.manage"),
  asyncHandler(async (req, res) => {
    ok(res, await configurePlanCommercial(paramString(req.params.applicationKey)!, paramString(req.params.planKey)!, configurePlanCommercialSchema.parse(req.body), { userId: req.auth!.userId }));
  }),
);

selfServiceRouter.post(
  "/organizations/:organizationId/self-service/contracts",
  authenticate,
  requireOrganizationMembership(),
  rateLimit({ keyPrefix: "organization.self_service.contract", windowMs: 10 * 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");
    const result = await startSelfServiceContracting(req.membership!.organizationId, startSelfServiceSchema.parse(req.body), key.data, { userId: req.auth!.userId, requestId: req.requestId });
    res.set("Cache-Control", "no-store");
    ok(res, result, result.replayed ? 200 : 201);
  }),
);
