import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { memberships, organizations, roles } from "../../db/schema/index.js";

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
