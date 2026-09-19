import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformMemberships, platformRoles, users } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getPlatformRoleById, getPlatformRoleByKey } from "../platformRoles/service.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

interface PlatformMembershipRow {
  id: string;
  userId: string;
  platformRoleId: string;
  status: "ACTIVE" | "REVOKED";
}

function shapeAdmin(row: PlatformMembershipRow, userEmail: string, platformRoleKey: string) {
  return { userId: row.userId, userEmail, platformRole: platformRoleKey, status: row.status };
}

/** Used by `middleware/platformContext.ts` — the sole membership resolver the platform-admin authorization chain runs through. */
export async function findActivePlatformAdmin(
  userId: string,
): Promise<{ membershipId: string; platformRoleId: string; platformRoleKey: string } | null> {
  const [row] = await db
    .select({
      membershipId: platformMemberships.id,
      platformRoleId: platformMemberships.platformRoleId,
      platformRoleKey: platformRoles.key,
    })
    .from(platformMemberships)
    .innerJoin(platformRoles, eq(platformRoles.id, platformMemberships.platformRoleId))
    .where(and(eq(platformMemberships.userId, userId), eq(platformMemberships.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

/** Platform-scoped equivalent of `listMembershipsForOrganization` — every user who has ever held platform authority, active or revoked (auditable history, never deleted). */
export async function listPlatformAdmins() {
  return db
    .select({
      userId: platformMemberships.userId,
      userEmail: users.email,
      platformRole: platformRoles.key,
      status: platformMemberships.status,
      createdAt: platformMemberships.createdAt,
    })
    .from(platformMemberships)
    .innerJoin(users, eq(users.id, platformMemberships.userId))
    .innerJoin(platformRoles, eq(platformRoles.id, platformMemberships.platformRoleId))
    .orderBy(platformMemberships.createdAt);
}

async function getMembershipRowByUserId(userId: string): Promise<PlatformMembershipRow | null> {
  const [row] = await db
    .select({
      id: platformMemberships.id,
      userId: platformMemberships.userId,
      platformRoleId: platformMemberships.platformRoleId,
      status: platformMemberships.status,
    })
    .from(platformMemberships)
    .where(eq(platformMemberships.userId, userId))
    .limit(1);
  return (row as PlatformMembershipRow) ?? null;
}

async function countOtherActivePlatformAdmins(excludeMembershipId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(platformMemberships)
    .where(and(eq(platformMemberships.status, "ACTIVE"), ne(platformMemberships.id, excludeMembershipId)));
  return row?.count ?? 0;
}

/**
 * Grants platform authority to an already-existing User (never creates
 * one — CLAUDE.md's Phase 13 brief §"PLATFORM ADMIN MANAGEMENT": the
 * target must already have authenticated with Supabase at least once, the
 * same precondition `createMembership` already enforces for organization
 * invites). Only reachable behind `platform.platform_admin.manage`, so the
 * caller is by construction already a platform administrator — this can
 * never be the FIRST admin (see modules/platformAdmins/bootstrap.ts for
 * that) and can never be called by a plain Organization OWNER/ADMIN, which
 * is what rules out self-escalation from organization authority to
 * platform authority.
 */
export async function grantPlatformAdmin(input: {
  targetUserId: string;
  platformRoleKey: string;
  actorUserId?: string;
}) {
  const [targetUser] = await db.select().from(users).where(eq(users.id, input.targetUserId)).limit(1);
  if (!targetUser) {
    throw new NotFoundError(
      "User not found — they must have authenticated with the platform at least once before being granted platform authority",
    );
  }

  const role = await getPlatformRoleByKey(input.platformRoleKey);
  const existing = await getMembershipRowByUserId(input.targetUserId);

  if (existing?.status === "ACTIVE") {
    throw new ConflictError("User is already an active platform administrator");
  }

  let row: PlatformMembershipRow;
  let action: string;
  if (existing) {
    const [updated] = await db
      .update(platformMemberships)
      .set({ status: "ACTIVE", platformRoleId: role.id, updatedAt: new Date() })
      .where(eq(platformMemberships.id, existing.id))
      .returning();
    if (!updated) throw new Error("Failed to reactivate platform admin");
    row = updated as PlatformMembershipRow;
    action = "platform.admin.updated";
  } else {
    const [inserted] = await db
      .insert(platformMemberships)
      .values({ userId: input.targetUserId, platformRoleId: role.id })
      .returning();
    if (!inserted) throw new Error("Failed to grant platform admin");
    row = inserted as PlatformMembershipRow;
    action = "platform.admin.created";
  }

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    action,
    targetType: "platform_membership",
    targetId: row.id,
    metadata: { targetUserId: input.targetUserId, platformRoleKey: role.key },
  });

  return shapeAdmin(row, targetUser.email, role.key);
}

/**
 * Handles both revocation and (rarer) role reassignment while active. The
 * last-active-admin guard mirrors `updateMembership`'s "cannot demote the
 * organization's last OWNER" — here at platform scope: if the target is
 * the only ACTIVE platform_membership row, revoking them would leave the
 * control plane with no administrator able to grant anyone else access
 * again (the HTTP route to do so is itself gated behind an active admin).
 * This applies identically whether the actor is revoking themselves or
 * someone else — `countOtherActivePlatformAdmins` excludes the target's
 * own row either way.
 */
export async function updatePlatformAdmin(input: {
  targetUserId: string;
  status?: "ACTIVE" | "REVOKED";
  platformRoleKey?: string;
  actorUserId?: string;
}) {
  const current = await getMembershipRowByUserId(input.targetUserId);
  if (!current) throw new NotFoundError("This user has never been granted platform authority");

  if (input.status === "REVOKED") {
    // Same "cannot be repeated" posture as api-keys/webhooks revoke — see
    // modules/apiKeys/service.ts and modules/webhooks/service.ts.
    if (current.status === "REVOKED") {
      throw new ConflictError("Platform administrator access is already revoked");
    }
    const otherActiveAdmins = await countOtherActivePlatformAdmins(current.id);
    if (otherActiveAdmins === 0) {
      throw new ConflictError("Cannot revoke the platform's last active administrator");
    }
  }

  const nextRole = input.platformRoleKey ? await getPlatformRoleByKey(input.platformRoleKey) : undefined;

  const [updated] = await db
    .update(platformMemberships)
    .set({
      ...(nextRole ? { platformRoleId: nextRole.id } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(platformMemberships.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError("This user has never been granted platform authority");

  const [targetUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.targetUserId)).limit(1);
  const currentRole = nextRole ?? (await getPlatformRoleById(updated.platformRoleId));

  const action = input.status === "REVOKED" ? "platform.admin.revoked" : "platform.admin.updated";
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    action,
    targetType: "platform_membership",
    targetId: updated.id,
    metadata: { targetUserId: input.targetUserId, status: input.status, platformRoleKey: input.platformRoleKey },
  });

  return shapeAdmin(updated as PlatformMembershipRow, targetUser?.email ?? "", currentRole.key);
}
