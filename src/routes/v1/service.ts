import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ForbiddenError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

/**
 * The service-credential equivalent of `GET /v1/me`: lets a machine
 * credential introspect its own identity and granted scopes. Human-only
 * routes are unaffected (this 403s a human caller, mirroring `/me` never
 * accepting a service credential in the other direction).
 */
export const serviceRouter = Router();

serviceRouter.get(
  "/service/me",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.service) throw new ForbiddenError("This endpoint requires a service credential");

    ok(res, {
      apiKeyId: req.service.apiKeyId,
      application: req.service.applicationKey,
      organizationId: req.service.organizationId,
      scopes: req.service.scopes,
    });
  }),
);
