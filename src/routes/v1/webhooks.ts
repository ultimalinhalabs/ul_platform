import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { createWebhookEndpointSchema } from "../../modules/webhooks/schemas.js";
import {
  createWebhookEndpoint,
  getWebhookEndpointDetail,
  listWebhookEndpointsForOrganization,
  revokeWebhookEndpoint,
  testWebhookEndpoint,
} from "../../modules/webhooks/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Human-only, organization-scoped webhook endpoint management — same
 * authorization posture as api-keys.ts: `webhook.manage` (create/revoke/
 * test, OWNER-only in the seed) vs `webhook.read` (metadata only,
 * OWNER+ADMIN). Publishing an event that *triggers* delivery is a
 * completely different, service-only concern — see routes/v1/events.ts.
 */
export const webhooksRouter = Router();

webhooksRouter.post(
  "/organizations/:organizationId/webhooks",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("webhook.manage"),
  asyncHandler(async (req, res) => {
    const body = createWebhookEndpointSchema.parse(req.body);
    const endpoint = await createWebhookEndpoint({
      organizationId: req.membership!.organizationId,
      applicationKey: body.applicationKey,
      url: body.url,
      eventTypes: body.eventTypes,
      actorUserId: req.auth!.userId,
    });
    // secret is present in this one response only — never again
    ok(res, endpoint, 201);
  }),
);

webhooksRouter.get(
  "/organizations/:organizationId/webhooks",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("webhook.read"),
  asyncHandler(async (req, res) => {
    const endpoints = await listWebhookEndpointsForOrganization(req.membership!.organizationId);
    ok(res, endpoints);
  }),
);

webhooksRouter.get(
  "/organizations/:organizationId/webhooks/:webhookId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("webhook.read"),
  asyncHandler(async (req, res) => {
    const endpoint = await getWebhookEndpointDetail(
      req.membership!.organizationId,
      paramString(req.params.webhookId)!,
    );
    ok(res, endpoint);
  }),
);

webhooksRouter.post(
  "/organizations/:organizationId/webhooks/:webhookId/revoke",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("webhook.manage"),
  asyncHandler(async (req, res) => {
    const endpoint = await revokeWebhookEndpoint({
      organizationId: req.membership!.organizationId,
      webhookId: paramString(req.params.webhookId)!,
      actorUserId: req.auth!.userId,
    });
    ok(res, endpoint);
  }),
);

webhooksRouter.post(
  "/organizations/:organizationId/webhooks/:webhookId/test",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("webhook.manage"),
  asyncHandler(async (req, res) => {
    const result = await testWebhookEndpoint({
      organizationId: req.membership!.organizationId,
      webhookId: paramString(req.params.webhookId)!,
    });
    ok(res, result);
  }),
);
