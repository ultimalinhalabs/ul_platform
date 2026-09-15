import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { permissions, rolePermissions } from "../../db/schema/index.js";
import { ForbiddenError } from "../../shared/errors.js";

export async function roleHasPermission(roleId: string, permissionKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: permissions.id })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(rolePermissions.roleId, roleId), eq(permissions.key, permissionKey)))
    .limit(1);

  return Boolean(row);
}

/**
 * `role.assign` (granted to OWNER and ADMIN) authorizes reassigning roles
 * in general, but must not let an ADMIN mint a new OWNER or tamper with an
 * existing OWNER's membership — that would let ADMIN escalate itself (or
 * an ally) to full control. This is a capability check on the specific
 * OWNER role, not a numeric role hierarchy: any role change that involves
 * OWNER (as the membership's current role or the role being assigned to
 * it) requires the actor to already be an OWNER.
 */
export function assertOwnerRoleChangeAllowed(
  actorRoleKey: string,
  roleKeysInvolved: Array<string | undefined>,
) {
  const touchesOwner = roleKeysInvolved.includes("OWNER");
  if (touchesOwner && actorRoleKey !== "OWNER") {
    throw new ForbiddenError("Only an OWNER can grant the OWNER role or modify an OWNER's membership");
  }
}
