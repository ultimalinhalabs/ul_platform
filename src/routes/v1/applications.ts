import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getApplicationByKey, listApplications } from "../../modules/applications/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Read-only for now (see roles.ts for the same reasoning): the
 * application registry is platform-owned, not organization data, and
 * there's no PLATFORM_ADMIN actor yet to gate mutations with safely.
 * Creating/activating/suspending applications is deferred to the future
 * UL Platform Console's administrative context — not built here.
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
