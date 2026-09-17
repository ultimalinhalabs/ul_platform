import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireServiceOrganizationMatch } from "../../middleware/requireServiceOrganizationMatch.js";
import { requireServiceScope } from "../../middleware/requireServiceScope.js";
import { publishEventSchema } from "../../modules/webhooks/schemas.js";
import { publishEvent } from "../../modules/webhooks/delivery.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ok } from "../../shared/response.js";

/**
 * "Something happened" (CLAUDE.md §14) — the one and only trigger for
 * webhook delivery. Service-only, never human: an event's source
 * application must always be a real authenticated credential, never a
 * request body field (see requireServiceOrganizationMatch). This is
 * platform transport, not a business endpoint — UL Platform never
 * interprets `type`/`data`, it only routes them to subscribed endpoints.
 */
export const eventsRouter = Router();

eventsRouter.post(
  "/organizations/:organizationId/events",
  authenticate,
  requireServiceOrganizationMatch(),
  requireServiceScope("event.publish"),
  asyncHandler(async (req, res) => {
    const body = publishEventSchema.parse(req.body);
    const result = await publishEvent({
      organizationId: req.service!.organizationId!,
      sourceApplicationKey: req.service!.applicationKey,
      type: body.type,
      data: body.data,
    });
    ok(res, result, 202);
  }),
);
