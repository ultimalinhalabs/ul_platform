import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getActiveApplicationKeys } from "../../modules/applicationAccess/service.js";
import { resolveEffectiveApplicationRole } from "../../modules/applicationRoles/effectiveRole.js";
import { getExplicitApplicationRoles } from "../../modules/applicationRoles/service.js";
import { listMembershipsForUser } from "../../modules/memberships/service.js";
import { getUserStatus, isEmailVerified } from "../../modules/users/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

export const meRouter = Router();

/**
 * The identity contract every application consumes (Na Pista today, QD from
 * Fase 6). Fase 6 adds — additively, existing fields unchanged — the user's
 * platform status, whether the IdP confirmed the email (server-side, never
 * from user_metadata), each organization's status, and per membership the
 * applications the ORGANIZATION has access to with the member's effective
 * application role (explicit, or the documented fallback). Consumers must
 * still enforce: membership.status === "active" and
 * organization.status === "active" before operating.
 */
meRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    const userId = req.auth.userId;
    const [rows, status, emailVerified] = await Promise.all([
      listMembershipsForUser(userId),
      getUserStatus(userId),
      isEmailVerified(userId),
    ]);
    const [accessByOrganization, explicitRoles] = await Promise.all([
      getActiveApplicationKeys([...new Set(rows.map((m) => m.organizationId))]),
      getExplicitApplicationRoles(rows.map((m) => m.membershipId)),
    ]);

    ok(res, {
      userId,
      email: req.auth.email,
      emailVerified,
      status,
      memberships: rows.map((m) => ({
        membershipId: m.membershipId,
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        roleKey: m.roleKey,
        status: m.status,
        organization: { id: m.organizationId, name: m.organizationName, slug: m.organizationSlug, status: m.organizationStatus },
        applications: (accessByOrganization.get(m.organizationId) ?? []).map((applicationKey) => {
          const role = resolveEffectiveApplicationRole({
            applicationKey,
            organizationRoleKey: m.roleKey,
            explicitRoleKey: explicitRoles.get(m.membershipId)?.get(applicationKey) ?? null,
          });
          return { key: applicationKey, roleKey: role?.roleKey ?? null, roleSource: role?.source ?? null };
        }),
      })),
    });
  }),
);
