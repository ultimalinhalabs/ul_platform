import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { createApplicationSchema, updateApplicationSchema } from "../../modules/applications/schemas.js";
import {
  createApplication,
  getApplicationByKey,
  listApplications,
  updateApplication,
} from "../../modules/applications/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * `GET`s stay auth-only, unchanged from Phase 12 (see roles.ts for the same
 * reasoning): the application registry is platform-owned, not organization
 * data, but reading it is non-sensitive metadata open to any authenticated
 * user. Phase 13 adds the mutation half — `platform.application.manage`,
 * held only by `PLATFORM_ADMIN` — now that a safely-gateable platform
 * actor exists. An Organization OWNER/ADMIN/MANAGER/STAFF has no path to
 * these two routes no matter how the organization's own roles are
 * configured: `requirePlatformMembership` resolves authority purely from
 * `req.auth.userId` against `platform_memberships`, never from any
 * Organization/Membership table.
 */
export const applicationsRouter = Router();

applicationsRouter.get(
  "/applications",
  authenticate,
  asyncHandler(async (_req, res) => {
    ok(res, await listApplications());
  }),
);

applicationsRouter.get(
  "/applications/:applicationKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const application = await getApplicationByKey(paramString(req.params.applicationKey)!);
    ok(res, application);
  }),
);

applicationsRouter.post(
  "/applications",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.application.manage"),
  asyncHandler(async (req, res) => {
    const body = createApplicationSchema.parse(req.body);
    const application = await createApplication({ ...body, actorUserId: req.auth!.userId });
    ok(res, application, 201);
  }),
);

applicationsRouter.patch(
  "/applications/:applicationKey",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.application.manage"),
  asyncHandler(async (req, res) => {
    const body = updateApplicationSchema.parse(req.body);
    const application = await updateApplication(paramString(req.params.applicationKey)!, body, req.auth!.userId);
    ok(res, application);
  }),
);
