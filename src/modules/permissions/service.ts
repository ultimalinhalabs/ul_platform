import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { permissions } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";

/** Platform-defined permission catalog, for read-only display. */
export async function listPermissions() {
  return db
    .select({ key: permissions.key, description: permissions.description })
    .from(permissions)
    .orderBy(permissions.key);
}

export async function getPermissionByKey(key: string) {
  const [permission] = await db
    .select({ key: permissions.key, description: permissions.description })
    .from(permissions)
    .where(eq(permissions.key, key))
    .limit(1);
  if (!permission) throw new NotFoundError(`Unknown permission: ${key}`);
  return permission;
}
