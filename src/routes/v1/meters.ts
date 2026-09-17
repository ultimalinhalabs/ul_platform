import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { listApplicationMeters, listMeters } from "../../modules/usage/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Read-only, human-only, same posture as roles/permissions/applications/
 * service-scopes: the meter registry and its per-application allowlist are
 * platform-owned structural metadata, not tenant data — auth is enough.
 * Lets a product team see which meter keys exist and which ones their
 * application may record against before calling the usage-write endpoint.
 */
export const metersRouter = Router();

metersRouter.get(
  "/meters",
  authenticate,
  asyncHandler(async (_req, res) => {
    ok(res, await listMeters());
  }),
);

metersRouter.get(
  "/applications/:applicationKey/meters",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await listApplicationMeters(paramString(req.params.applicationKey)!);
    ok(res, result);
  }),
);
