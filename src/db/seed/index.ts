import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { db } from "../index.js";
import { applications, permissions, rolePermissions, roles } from "../schema/index.js";
import { APPLICATIONS, PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "./data.js";

/**
 * Idempotent: safe to run any number of times. Upserts by unique key so a
 * repeated run converges to the same state instead of duplicating rows.
 */
export async function seed() {
  return db.transaction(async (tx) => {
    const appRows = await tx
      .insert(applications)
      .values(APPLICATIONS.map((a) => ({ ...a })))
      .onConflictDoUpdate({
        target: applications.key,
        set: { name: sql`excluded.name`, description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: applications.id, key: applications.key });

    const permRows = await tx
      .insert(permissions)
      .values(PERMISSIONS.map((p) => ({ ...p })))
      .onConflictDoUpdate({
        target: permissions.key,
        set: { description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: permissions.id, key: permissions.key });

    const roleRows = await tx
      .insert(roles)
      .values(ROLES.map((r) => ({ ...r })))
      .onConflictDoUpdate({
        target: roles.key,
        set: { name: sql`excluded.name`, description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: roles.id, key: roles.key });

    const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));
    const permIdByKey = new Map(permRows.map((p) => [p.key, p.id]));

    const rolePermissionRows = Object.entries(ROLE_PERMISSIONS).flatMap(([roleKey, permKeys]) => {
      const roleId = roleIdByKey.get(roleKey);
      if (!roleId) throw new Error(`Seed error: role "${roleKey}" was not upserted`);
      return permKeys.map((permKey) => {
        const permissionId = permIdByKey.get(permKey);
        if (!permissionId) throw new Error(`Seed error: permission "${permKey}" was not upserted`);
        return { roleId, permissionId };
      });
    });

    if (rolePermissionRows.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(rolePermissionRows)
        .onConflictDoNothing({
          target: [rolePermissions.roleId, rolePermissions.permissionId],
        });
    }

    return {
      applications: appRows.length,
      permissions: permRows.length,
      roles: roleRows.length,
      rolePermissions: rolePermissionRows.length,
    };
  });
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  seed()
    .then((summary) => {
      console.log("Seed complete:", summary);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
