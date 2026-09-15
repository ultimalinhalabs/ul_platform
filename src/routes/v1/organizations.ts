import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { roleHasPermission } from "../../modules/authorization/service.js";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
} from "../../modules/organizations/schemas.js";
import {
  createOrganization,
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
import { ForbiddenError, UnauthorizedError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

export const organizationsRouter = Router();

organizationsRouter.post(
  "/organizations",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    const body = createOrganizationSchema.parse(req.body);
    const organization = await createOrganization({ ...body, createdBy: req.auth.userId });
    ok(res, organization, 201);
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
    });
    ok(res, { deleted: true });
  }),
);
