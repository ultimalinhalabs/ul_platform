import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { listApplicationServiceScopes, listServiceScopes } from "../../modules/serviceScopes/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Read-only, human-only, same posture as roles.ts/permissions.ts/
 * applications.ts: the scope registry and its per-application allowlist
 * are platform-owned structural metadata, not tenant data — auth is
 * enough, no organization context or extra permission needed. Lets an
 * organization admin see which scopes exist and which ones a given
 * application's credentials may actually request before calling
 * `POST /organizations/:id/api-keys`.
 */
export const serviceScopesRouter = Router();

serviceScopesRouter.get(
  "/service-scopes",
  authenticate,
  asyncHandler(async (_req, res) => {
    ok(res, await listServiceScopes());
  }),
);

serviceScopesRouter.get(
  "/applications/:applicationKey/service-scopes",
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await listApplicationServiceScopes(paramString(req.params.applicationKey)!);
    ok(res, result);
  }),
);
