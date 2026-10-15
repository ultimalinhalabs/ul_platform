import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import {
  acceptInvitation,
  createInvitation,
  createInvitationSchema,
  declineInvitation,
  listInvitations,
  listMyInvitations,
  revokeInvitation,
} from "../../modules/memberships/invitations.service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Migration 0025 — team invitations by email (F17 Gap 1).
 *  - Organization side (OWNER/ADMIN: `membership.create` to invite/revoke, `membership.read` to list).
 *  - Invitee side (`/me/invitations`): only invitations addressed to the caller's VERIFIED email; accepting
 *    creates the membership. Nothing here reveals whether an email has an account.
 */
export const invitationsRouter = Router();

invitationsRouter.post(
  "/organizations/:organizationId/invitations",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.create"),
  rateLimit({ keyPrefix: "organization.invitation.create", windowMs: 10 * 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    const body = createInvitationSchema.parse(req.body);
    const invitation = await createInvitation({ organizationId: req.membership!.organizationId, ...body, actorUserId: req.auth!.userId, actorRoleKey: req.membership!.roleKey });
    ok(res, invitation, 201);
  }),
);

invitationsRouter.get(
  "/organizations/:organizationId/invitations",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.read"),
  asyncHandler(async (req, res) => ok(res, await listInvitations(req.membership!.organizationId))),
);

invitationsRouter.post(
  "/organizations/:organizationId/invitations/:invitationId/revoke",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("membership.create"),
  asyncHandler(async (req, res) => {
    ok(res, await revokeInvitation({ organizationId: req.membership!.organizationId, invitationId: paramString(req.params.invitationId)!, actorUserId: req.auth!.userId, actorRoleKey: req.membership!.roleKey }));
  }),
);

invitationsRouter.get(
  "/me/invitations",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    res.set("Cache-Control", "no-store");
    ok(res, await listMyInvitations(req.auth.userId));
  }),
);

invitationsRouter.post(
  "/me/invitations/:invitationId/accept",
  authenticate,
  rateLimit({ keyPrefix: "me.invitation.respond", windowMs: 10 * 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    const result = await acceptInvitation(req.auth.userId, paramString(req.params.invitationId)!);
    ok(res, result, result.created ? 201 : 200);
  }),
);

invitationsRouter.post(
  "/me/invitations/:invitationId/decline",
  authenticate,
  rateLimit({ keyPrefix: "me.invitation.respond", windowMs: 10 * 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    ok(res, await declineInvitation(req.auth.userId, paramString(req.params.invitationId)!));
  }),
);
