import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { discoverQuerySchema } from "../../modules/discovery/schemas.js";
import { discoverService } from "../../modules/discovery/service.js";
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

/**
 * Service Discovery — "where do I reach this other application" — never a
 * proxy (see README "Service Discovery"). Source identity is always
 * `req.service.applicationKey`, the authenticated credential's own
 * stored value; there is no `source` query param to spoof (CLAUDE.md's
 * discovery prompt §19). Not organization-scoped — see modules/discovery.
 */
serviceRouter.get(
  "/service/discover",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.service) throw new ForbiddenError("This endpoint requires a service credential");

    const query = discoverQuerySchema.parse(req.query);
    const result = await discoverService({
      sourceApplicationKey: req.service.applicationKey,
      targetApplicationKey: query.target,
      environmentKey: query.environment,
    });
    ok(res, result);
  }),
);
