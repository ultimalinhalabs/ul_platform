import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { createEndpointSchema, updateEndpointSchema } from "../../modules/endpoints/schemas.js";
import { createEndpoint, listEndpointsForEnvironment, updateEndpointStatus } from "../../modules/endpoints/service.js";
import { createEnvironmentSchema, updateEnvironmentSchema } from "../../modules/environments/schemas.js";
import {
  createEnvironment,
  getEnvironmentDetail,
  listEnvironmentsForApplication,
  updateEnvironmentStatus,
} from "../../modules/environments/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { NotFoundError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * `GET`s stay auth-only, human-only, unchanged from Phase 12 — same
 * posture as roles/permissions/applications/service-scopes/meters:
 * Environments and Endpoints are platform-owned infrastructure metadata,
 * not tenant data, and reading them is non-sensitive. All
 * environments/endpoints are listed regardless of `status` (unlike Plans
 * hiding ARCHIVED from its list) — this is operational visibility, not a
 * commercial catalog; `status` is simply a field in the response. Only
 * Service Discovery (routes/v1/service.ts) actually filters by status.
 *
 * Phase 13 adds the mutation half, now that `PLATFORM_ADMIN` exists to
 * gate it behind: `platform.environment.manage` / `platform.endpoint.manage`.
 * The service functions themselves (`createEnvironment`,
 * `updateEnvironmentStatus`, `createEndpoint`, `updateEndpointStatus`) are
 * unchanged from Phase 12 — they already validated, audited and were
 * fully tested; only the HTTP surface was missing.
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

environmentsRouter.post(
  "/applications/:applicationKey/environments",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.environment.manage"),
  asyncHandler(async (req, res) => {
    const body = createEnvironmentSchema.parse(req.body);
    const environment = await createEnvironment({
      applicationKey: paramString(req.params.applicationKey)!,
      key: body.key,
      actorUserId: req.auth!.userId,
    });
    ok(res, environment, 201);
  }),
);

environmentsRouter.patch(
  "/applications/:applicationKey/environments/:environmentKey",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.environment.manage"),
  asyncHandler(async (req, res) => {
    const body = updateEnvironmentSchema.parse(req.body);
    const environment = await updateEnvironmentStatus({
      applicationKey: paramString(req.params.applicationKey)!,
      environmentKey: paramString(req.params.environmentKey)!,
      status: body.status,
      actorUserId: req.auth!.userId,
    });
    ok(res, environment);
  }),
);

environmentsRouter.post(
  "/applications/:applicationKey/environments/:environmentKey/endpoints",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.endpoint.manage"),
  asyncHandler(async (req, res) => {
    const body = createEndpointSchema.parse(req.body);
    const endpoint = await createEndpoint({
      applicationKey: paramString(req.params.applicationKey)!,
      environmentKey: paramString(req.params.environmentKey)!,
      type: body.type,
      baseUrl: body.baseUrl,
      actorUserId: req.auth!.userId,
    });
    ok(res, endpoint, 201);
  }),
);

environmentsRouter.patch(
  "/applications/:applicationKey/environments/:environmentKey/endpoints/:endpointType",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.endpoint.manage"),
  asyncHandler(async (req, res) => {
    const endpointType = paramString(req.params.endpointType);
    if (endpointType !== "API") {
      throw new NotFoundError(`No "${endpointType}" endpoint type exists`);
    }
    const body = updateEndpointSchema.parse(req.body);
    const endpoint = await updateEndpointStatus({
      applicationKey: paramString(req.params.applicationKey)!,
      environmentKey: paramString(req.params.environmentKey)!,
      type: endpointType,
      status: body.status,
      actorUserId: req.auth!.userId,
    });
    ok(res, endpoint);
  }),
);
