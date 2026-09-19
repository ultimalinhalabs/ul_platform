import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { createIntegrationSchema, updateIntegrationSchema } from "../../modules/integrations/schemas.js";
import {
  createIntegration,
  getIntegrationDetail,
  listIntegrationsForSource,
  updateIntegrationStatus,
} from "../../modules/integrations/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * `GET`s stay read-only, human-only, unchanged from Phase 12 — same
 * posture as environments.ts. The Integration registry is platform-owned
 * structural metadata ("is A formally registered to talk to B"), never
 * authorization by itself (see README "Integration ≠ Authorization").
 *
 * Phase 13 adds the mutation half behind `platform.integration.manage`.
 * `createIntegration`/`updateIntegrationStatus` are unchanged from Phase
 * 12 (directional, one-way-only — see modules/integrations/service.ts);
 * only the HTTP surface was missing.
 */
export const integrationsRouter = Router();

integrationsRouter.get(
  "/applications/:sourceApplicationKey/integrations",
  authenticate,
  asyncHandler(async (req, res) => {
    ok(res, await listIntegrationsForSource(paramString(req.params.sourceApplicationKey)!));
  }),
);

integrationsRouter.get(
  "/applications/:sourceApplicationKey/integrations/:targetApplicationKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const detail = await getIntegrationDetail(
      paramString(req.params.sourceApplicationKey)!,
      paramString(req.params.targetApplicationKey)!,
    );
    ok(res, detail);
  }),
);

integrationsRouter.post(
  "/applications/:sourceApplicationKey/integrations/:targetApplicationKey",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.integration.manage"),
  asyncHandler(async (req, res) => {
    const body = createIntegrationSchema.parse(req.body);
    const integration = await createIntegration({
      sourceApplicationKey: paramString(req.params.sourceApplicationKey)!,
      targetApplicationKey: paramString(req.params.targetApplicationKey)!,
      description: body.description,
      actorUserId: req.auth!.userId,
    });
    ok(res, integration, 201);
  }),
);

integrationsRouter.patch(
  "/applications/:sourceApplicationKey/integrations/:targetApplicationKey",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.integration.manage"),
  asyncHandler(async (req, res) => {
    const body = updateIntegrationSchema.parse(req.body);
    const integration = await updateIntegrationStatus({
      sourceApplicationKey: paramString(req.params.sourceApplicationKey)!,
      targetApplicationKey: paramString(req.params.targetApplicationKey)!,
      status: body.status,
      description: body.description,
      actorUserId: req.auth!.userId,
    });
    ok(res, integration);
  }),
);
