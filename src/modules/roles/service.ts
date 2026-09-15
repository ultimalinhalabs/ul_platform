import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { permissions, rolePermissions, roles } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";

export async function getRoleByKey(key: string, executor: Pick<typeof db, "select"> = db) {
  const [role] = await executor.select().from(roles).where(eq(roles.key, key)).limit(1);
  if (!role) throw new NotFoundError(`Unknown role: ${key}`);
  return role;
}

/** Platform-defined role catalog, for read-only display (no internal ids/timestamps). */
export async function listRoles() {
  return db
    .select({ key: roles.key, name: roles.name, description: roles.description })
    .from(roles)
    .orderBy(roles.key);
}

export async function getRoleDetail(key: string) {
  const role = await getRoleByKey(key);

  const grantedPermissions = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, role.id))
    .orderBy(permissions.key);

  return {
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: grantedPermissions,
  };
}
