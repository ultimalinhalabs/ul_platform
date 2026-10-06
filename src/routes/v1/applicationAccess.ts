import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { listApplicationAccessForOrganization } from "../../modules/applicationAccess/service.js";
import {
  listApplicationRoles,
  removeMembershipApplicationRole,
  setMembershipApplicationRole,
} from "../../modules/applicationRoles/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Fase 6 — organization-scoped reads/writes for application access and
 * per-application roles. The organization always comes from the route
 * param and is validated against the caller's ACTIVE membership in an
 * ACTIVE organization (requireOrganizationMembership) — never from a body.
 * Granting/revoking access itself is a platform-admin operation (platform.ts).
 */
export const applicationAccessRouter = Router();

const setApplicationRoleSchema = z.object({ roleKey: z.string().min(1).max(64) });

/** An application's own role catalog. Auth-only, like the other registry reads. */
applicationAccessRouter.get(
  "/applications/:applicationKey/roles",
  authenticate,
  asyncHandler(async (req, res) => {
    ok(res, await listApplicationRoles(paramString(req.params.applicationKey)!));
  }),
);

applicationAccessRouter.get(
  "/organizations/:organizationId/application-access",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("application.read"),
  asyncHandler(async (req, res) => {
    ok(res, await listApplicationAccessForOrganization(req.membership!.organizationId));
  }),
);

applicationAccessRouter.put(
  "/organizations/:organizationId/memberships/:membershipId/applications/:applicationKey/role",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("role.assign"),
  asyncHandler(async (req, res) => {
    const body = setApplicationRoleSchema.parse(req.body);
    ok(
      res,
      await setMembershipApplicationRole({
        organizationId: req.membership!.organizationId,
        membershipId: paramString(req.params.membershipId)!,
        applicationKey: paramString(req.params.applicationKey)!,
        roleKey: body.roleKey,
        actorUserId: req.auth!.userId,
        actorRoleKey: req.membership!.roleKey,
      }),
    );
  }),
);

applicationAccessRouter.delete(
  "/organizations/:organizationId/memberships/:membershipId/applications/:applicationKey/role",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("role.assign"),
  asyncHandler(async (req, res) => {
    await removeMembershipApplicationRole({
      organizationId: req.membership!.organizationId,
      membershipId: paramString(req.params.membershipId)!,
      applicationKey: paramString(req.params.applicationKey)!,
      actorUserId: req.auth!.userId,
      actorRoleKey: req.membership!.roleKey,
    });
    ok(res, { removed: true });
  }),
);
