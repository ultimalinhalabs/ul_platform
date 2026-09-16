import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { cancelSubscriptionSchema, createSubscriptionSchema } from "../../modules/subscriptions/schemas.js";
import {
  cancelSubscription,
  createSubscription,
  getSubscriptionDetail,
  listOrganizationApplications,
  listSubscriptionsForOrganization,
} from "../../modules/subscriptions/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * `subscription.manage` (existing permission, already OWNER-only in the
 * seed) gates create/cancel; `subscription.read` gates every GET here,
 * including .../applications — that endpoint is a view *derived from*
 * subscriptions, not the global application registry, so it belongs to
 * the same permission as the data it's reading.
 */
export const subscriptionsRouter = Router();

subscriptionsRouter.post(
  "/organizations/:organizationId/subscriptions",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("subscription.manage"),
  asyncHandler(async (req, res) => {
    const body = createSubscriptionSchema.parse(req.body);
    const subscription = await createSubscription({
      organizationId: req.membership!.organizationId,
      ...body,
      actorUserId: req.auth!.userId,
    });
    ok(res, subscription, 201);
  }),
);

subscriptionsRouter.get(
  "/organizations/:organizationId/subscriptions",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("subscription.read"),
  asyncHandler(async (req, res) => {
    const subscriptions = await listSubscriptionsForOrganization(req.membership!.organizationId);
    ok(res, subscriptions);
  }),
);

subscriptionsRouter.get(
  "/organizations/:organizationId/subscriptions/:subscriptionId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("subscription.read"),
  asyncHandler(async (req, res) => {
    const subscription = await getSubscriptionDetail(
      req.membership!.organizationId,
      paramString(req.params.subscriptionId)!,
    );
    ok(res, subscription);
  }),
);

subscriptionsRouter.patch(
  "/organizations/:organizationId/subscriptions/:subscriptionId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("subscription.manage"),
  asyncHandler(async (req, res) => {
    cancelSubscriptionSchema.parse(req.body); // only {status: "canceled"} is valid in v1
    const subscription = await cancelSubscription({
      organizationId: req.membership!.organizationId,
      subscriptionId: paramString(req.params.subscriptionId)!,
      actorUserId: req.auth!.userId,
    });
    ok(res, subscription);
  }),
);

subscriptionsRouter.get(
  "/organizations/:organizationId/applications",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("subscription.read"),
  asyncHandler(async (req, res) => {
    const applications = await listOrganizationApplications(req.membership!.organizationId);
    ok(res, applications);
  }),
);
