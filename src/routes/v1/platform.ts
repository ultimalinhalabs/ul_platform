import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { platformAuditLogQuerySchema } from "../../modules/audit/schemas.js";
import { listPlatformAuditLogs } from "../../modules/audit/service.js";
import { grantPlatformAdminSchema, updatePlatformAdminSchema } from "../../modules/platformAdmins/schemas.js";
import {
  findActivePlatformAdmin,
  grantPlatformAdmin,
  listPlatformAdmins,
  updatePlatformAdmin,
} from "../../modules/platformAdmins/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Platform Control Plane administration — see README "Platform Control
 * Plane". Entirely separate authorization chain from every Organization
 * route in this API (CLAUDE.md's Phase 13 brief §"PRINCÍPIO FUNDAMENTAL"):
 * `requirePlatformMembership`/`requirePlatformPermission` never consult
 * `memberships`/`roles`/`permissions`, and no Organization route ever
 * consults `platform_memberships`. A user can be both an Organization
 * OWNER and a PLATFORM_ADMIN, but neither implies the other.
 */
export const platformRouter = Router();

/**
 * The platform-scope analogue of `GET /v1/me` — any authenticated human
 * may check their own status (never gated behind a platform permission
 * itself: you always may know whether *you* are a platform admin, the
 * same way `/me` always answers "what are my own memberships"). A plain
 * `false` for a non-admin, never a 403 — this is self-introspection, not
 * an administrative action.
 */
platformRouter.get(
  "/platform/me",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.auth) throw new UnauthorizedError();
    const admin = await findActivePlatformAdmin(req.auth.userId);
    ok(res, { platformAdmin: Boolean(admin), platformRole: admin?.platformRoleKey ?? null });
  }),
);

platformRouter.get(
  "/platform/admins",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.platform_admin.read"),
  asyncHandler(async (_req, res) => {
    ok(res, await listPlatformAdmins());
  }),
);

/**
 * Grants platform authority to an already-existing platform user (never
 * creates a Supabase/platform user — see modules/platformAdmins/service.ts).
 * Reaching this route at all already requires an active PLATFORM_ADMIN
 * with `platform.platform_admin.manage` — this is structurally why an
 * Organization OWNER/ADMIN can never self-promote through this endpoint,
 * and why creating the very first admin instead goes through the separate,
 * non-HTTP bootstrap mechanism (scripts/bootstrap-platform-admin.ts).
 */
platformRouter.post(
  "/platform/admins",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.platform_admin.manage"),
  asyncHandler(async (req, res) => {
    const body = grantPlatformAdminSchema.parse(req.body);
    const admin = await grantPlatformAdmin({
      targetUserId: body.userId,
      platformRoleKey: body.platformRoleKey,
      actorUserId: req.auth!.userId,
    });
    ok(res, admin, 201);
  }),
);

/**
 * Revoke, reactivate or (rarer) reassign role — see
 * `modules/platformAdmins/service.ts`'s `updatePlatformAdmin` for the
 * last-active-admin protection: this rejects (409) an attempt, by anyone
 * including the target themselves, to revoke the platform's sole
 * remaining active administrator.
 */
platformRouter.patch(
  "/platform/admins/:userId",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.platform_admin.manage"),
  asyncHandler(async (req, res) => {
    const body = updatePlatformAdminSchema.parse(req.body);
    const admin = await updatePlatformAdmin({
      targetUserId: paramString(req.params.userId)!,
      status: body.status,
      platformRoleKey: body.platformRoleKey,
      actorUserId: req.auth!.userId,
    });
    ok(res, admin);
  }),
);

/**
 * Control-plane audit trail — requires `platform.audit.read`. Never
 * returns a tenant/Organization event: `listPlatformAuditLogs` hard-codes
 * `organizationId IS NULL`, not a query the client can influence — see
 * modules/audit/service.ts.
 */
platformRouter.get(
  "/platform/audit-logs",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.audit.read"),
  asyncHandler(async (req, res) => {
    const query = platformAuditLogQuerySchema.parse(req.query);
    const result = await listPlatformAuditLogs(query);
    ok(res, result);
  }),
);
