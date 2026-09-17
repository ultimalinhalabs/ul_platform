import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getIntegrationDetail, listIntegrationsForSource } from "../../modules/integrations/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Read-only, human-only — same posture as environments.ts. The
 * Integration registry is platform-owned structural metadata ("is A
 * formally registered to talk to B"), never authorization by itself (see
 * README "Integration ≠ Authorization"). No POST/PATCH here for the same
 * reason environments/endpoints have none — no PLATFORM_ADMIN actor yet.
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
