import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { permissions, rolePermissions } from "../../db/schema/index.js";

export async function roleHasPermission(roleId: string, permissionKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: permissions.id })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(rolePermissions.roleId, roleId), eq(permissions.key, permissionKey)))
    .limit(1);

  return Boolean(row);
}
