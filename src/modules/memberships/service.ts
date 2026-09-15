import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { memberships, organizations, roles, users } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getRoleByKey } from "../roles/service.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

export async function findActiveMembership(userId: string, organizationId: string) {
  const [row] = await db
    .select({
      membershipId: memberships.id,
      roleId: memberships.roleId,
      roleKey: roles.key,
    })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, organizationId),
        eq(memberships.status, "active"),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function listMembershipsForUser(userId: string) {
  return db
    .select({
      membershipId: memberships.id,
      organizationId: memberships.organizationId,
      organizationName: organizations.name,
      roleKey: roles.key,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.userId, userId));
}

export async function listMembershipsForOrganization(organizationId: string) {
  return db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      userEmail: users.email,
      roleId: memberships.roleId,
      roleKey: roles.key,
      status: memberships.status,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.organizationId, organizationId));
}

async function countOtherActiveOwners(
  organizationId: string,
  ownerRoleId: string,
  excludeMembershipId: string,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.roleId, ownerRoleId),
        eq(memberships.status, "active"),
        ne(memberships.id, excludeMembershipId),
      ),
    );
  return row?.count ?? 0;
}

export async function createMembership(input: {
  organizationId: string;
  userId: string;
  roleKey: string;
  status?: "active" | "invited" | "suspended";
  actorUserId: string;
}) {
  const [targetUser] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!targetUser) {
    throw new NotFoundError(
      "User not found — they must have authenticated with the platform at least once",
    );
  }

  const role = await getRoleByKey(input.roleKey);

  const [membership] = await db
    .insert(memberships)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      roleId: role.id,
      status: input.status ?? "active",
    })
    .returning();
  if (!membership) throw new Error("Failed to create membership");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    action: "membership.created",
    targetType: "membership",
    targetId: membership.id,
    metadata: { userId: input.userId, roleKey: input.roleKey },
  });

  return membership;
}

export async function updateMembership(input: {
  organizationId: string;
  membershipId: string;
  roleKey?: string;
  status?: "active" | "invited" | "suspended";
  actorUserId: string;
}) {
  const [current] = await db
    .select({ id: memberships.id, roleKey: roles.key, status: memberships.status, roleId: memberships.roleId })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.id, input.membershipId), eq(memberships.organizationId, input.organizationId)))
    .limit(1);
  if (!current) throw new NotFoundError("Membership not found");

  const nextRole = input.roleKey ? await getRoleByKey(input.roleKey) : undefined;
  const wasActiveOwner = current.roleKey === "OWNER" && current.status === "active";
  const willStillBeActiveOwner =
    (nextRole ? nextRole.key === "OWNER" : current.roleKey === "OWNER") &&
    (input.status ?? current.status) === "active";

  if (wasActiveOwner && !willStillBeActiveOwner) {
    const ownerRole = nextRole?.key === "OWNER" ? nextRole : await getRoleByKey("OWNER");
    const otherOwners = await countOtherActiveOwners(input.organizationId, ownerRole.id, input.membershipId);
    if (otherOwners === 0) {
      throw new ConflictError("Cannot change the organization's last active owner");
    }
  }

  const [updated] = await db
    .update(memberships)
    .set({
      ...(nextRole ? { roleId: nextRole.id } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(memberships.id, input.membershipId))
    .returning();
  if (!updated) throw new NotFoundError("Membership not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    action: "membership.updated",
    targetType: "membership",
    targetId: input.membershipId,
    metadata: { roleKey: input.roleKey, status: input.status },
  });

  return updated;
}

export async function removeMembership(input: {
  organizationId: string;
  membershipId: string;
  actorUserId: string;
}) {
  const [current] = await db
    .select({ id: memberships.id, roleKey: roles.key, status: memberships.status })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.id, input.membershipId), eq(memberships.organizationId, input.organizationId)))
    .limit(1);
  if (!current) throw new NotFoundError("Membership not found");

  if (current.roleKey === "OWNER" && current.status === "active") {
    const ownerRole = await getRoleByKey("OWNER");
    const otherOwners = await countOtherActiveOwners(input.organizationId, ownerRole.id, input.membershipId);
    if (otherOwners === 0) {
      throw new ConflictError("Cannot remove the organization's last active owner");
    }
  }

  await db.delete(memberships).where(eq(memberships.id, input.membershipId));

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    action: "membership.removed",
    targetType: "membership",
    targetId: input.membershipId,
  });
}
