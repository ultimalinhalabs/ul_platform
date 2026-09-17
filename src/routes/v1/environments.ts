import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { listEndpointsForEnvironment } from "../../modules/endpoints/service.js";
import { getEnvironmentDetail, listEnvironmentsForApplication } from "../../modules/environments/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Read-only, human-only, same posture as roles/permissions/applications/
 * service-scopes/meters: Environments and Endpoints are platform-owned
 * infrastructure metadata, not tenant data — auth is enough, no
 * organization context or extra permission needed. There is no
 * POST/PATCH here (see README "Who may manage platform applications?" —
 * no PLATFORM_ADMIN actor exists yet to safely gate mutation behind, the
 * identical reasoning applications.ts already documents for the
 * Application registry itself). All environments/endpoints are listed
 * regardless of `status` (unlike Plans hiding ARCHIVED from its list) —
 * this is operational visibility, not a commercial catalog; `status` is
 * simply a field in the response. Only Service Discovery (routes/v1/
 * service.ts) actually filters by status.
 */
export const environmentsRouter = Router();

environmentsRouter.get(
  "/applications/:applicationKey/environments",
  authenticate,
  asyncHandler(async (req, res) => {
    ok(res, await listEnvironmentsForApplication(paramString(req.params.applicationKey)!));
  }),
);

environmentsRouter.get(
  "/applications/:applicationKey/environments/:environmentKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const detail = await getEnvironmentDetail(
      paramString(req.params.applicationKey)!,
      paramString(req.params.environmentKey)!,
    );
    ok(res, detail);
  }),
);

environmentsRouter.get(
  "/applications/:applicationKey/environments/:environmentKey/endpoints",
  authenticate,
  asyncHandler(async (req, res) => {
    const endpoints = await listEndpointsForEnvironment(
      paramString(req.params.applicationKey)!,
      paramString(req.params.environmentKey)!,
    );
    ok(res, endpoints);
  }),
);
