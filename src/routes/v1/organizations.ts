import { Router } from "express";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { roleHasPermission } from "../../modules/authorization/service.js";
import { idempotencyKeySchema } from "../../modules/commercial/schemas.js";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
} from "../../modules/organizations/schemas.js";
import { isEmailVerified } from "../../modules/users/service.js";
import {
  createOrganizationIdempotently,
  deleteOrganization,
  getOrganizationById,
  updateOrganization,
} from "../../modules/organizations/service.js";
import { createMembershipSchema, updateMembershipSchema } from "../../modules/memberships/schemas.js";
import {
  createMembership,
  listMembershipsForOrganization,
  removeMembership,
  updateMembership,
} from "../../modules/memberships/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { EmailNotVerifiedError, ForbiddenError, UnauthorizedError, ValidationError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

export const organizationsRouter = Router();

/**
 * Self-service tenant creation. Requires an email the identity provider has
 * verified (auth.users, never user_metadata) and an Idempotency-Key, so a
 * retried submission returns the organization it already created (200)
 * instead of a second one. Grants OWNER only — no application, subscription
 * or contract (see createOrganizationIdempotently).
 */
organizationsRouter.post(
  "/organizations",
  authenticate,
  rateLimit({ keyPrefix: "organization.create", windowMs: 10 * 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");
    const body = createOrganizationSchema.parse(req.body);
    if (!(await isEmailVerified(req.auth.userId))) throw new EmailNotVerifiedError();

    const { organization, replayed } = await createOrganizationIdempotently({
      ...body,
      createdBy: req.auth.userId,
      idempotencyKey: key.data,
      dailyLimit: env.ORGANIZATION_CREATION_DAILY_LIMIT,
    });
    res.set("Cache-Control", "no-store");
    if (replayed) res.set("Idempotent-Replayed", "true");
    ok(res, organization, replayed ? 200 : 201);
  }),
);

organizationsRouter.get(
  "/organizations/:organizationId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("organization.read"),
  asyncHandler(async (req, res) => {
    const organization = await getOrganizationById(req.membership!.organizationId);
    ok(res, organization);
  }),
);

organizationsRouter.patch(
  "/organizations/:organizationId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("organization.update"),
  asyncHandler(async (req, res) => {
    const body = updateOrganizationSchema.parse(req.body);
    const organization = await updateOrganization(req.membership!.organizationId, body, req.auth!.userId);
    ok(res, organization);
  }),
);

organizationsRouter.delete(
  "/organizations/:organizationId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("organization.delete"),
  asyncHandler(async (req, res) => {
    await deleteOrganization(req.membership!.organizationId, req.auth!.userId);
    ok(res, { deleted: true });
  }),
);

organizationsRouter.get(
  "/organizations/:organizationId/memberships",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.read"),
  asyncHandler(async (req, res) => {
    const rows = await listMembershipsForOrganization(req.membership!.organizationId);
    ok(res, rows);
  }),
);

organizationsRouter.post(
  "/organizations/:organizationId/memberships",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.create"),
  asyncHandler(async (req, res) => {
    const body = createMembershipSchema.parse(req.body);
    const membership = await createMembership({
      organizationId: req.membership!.organizationId,
      ...body,
      actorUserId: req.auth!.userId,
      actorRoleKey: req.membership!.roleKey,
    });
    ok(res, membership, 201);
  }),
);

organizationsRouter.patch(
  "/organizations/:organizationId/memberships/:membershipId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.update"),
  asyncHandler(async (req, res) => {
    const body = updateMembershipSchema.parse(req.body);

    // Reassigning a role is a distinct, more sensitive capability than
    // changing status (e.g. suspending a member) — require both permissions.
    if (body.roleKey && !(await roleHasPermission(req.membership!.roleId, "role.assign"))) {
      throw new ForbiddenError("Missing permission: role.assign");
    }

    const membership = await updateMembership({
      organizationId: req.membership!.organizationId,
      membershipId: paramString(req.params.membershipId)!,
      ...body,
      actorUserId: req.auth!.userId,
      actorRoleKey: req.membership!.roleKey,
    });
    ok(res, membership);
  }),
);

organizationsRouter.delete(
  "/organizations/:organizationId/memberships/:membershipId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.remove"),
  asyncHandler(async (req, res) => {
    await removeMembership({
      organizationId: req.membership!.organizationId,
      membershipId: paramString(req.params.membershipId)!,
      actorUserId: req.auth!.userId,
      actorRoleKey: req.membership!.roleKey,
    });
    ok(res, { deleted: true });
  }),
);
