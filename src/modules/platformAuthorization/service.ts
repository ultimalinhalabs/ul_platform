import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformPermissions, platformRolePermissions } from "../../db/schema/index.js";

/** Control-plane counterpart of modules/authorization/service.ts's `roleHasPermission`. */
export async function platformRoleHasPermission(platformRoleId: string, permissionKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: platformPermissions.id })
    .from(platformRolePermissions)
    .innerJoin(platformPermissions, eq(platformPermissions.id, platformRolePermissions.platformPermissionId))
    .where(
      and(
        eq(platformRolePermissions.platformRoleId, platformRoleId),
        eq(platformPermissions.key, permissionKey),
      ),
    )
    .limit(1);

  return Boolean(row);
}
