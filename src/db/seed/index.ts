import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { db } from "../index.js";
import { applications, permissions, planEntitlements, plans, rolePermissions, roles } from "../schema/index.js";
import {
  APPLICATIONS,
  PERMISSIONS,
  PLAN_ENTITLEMENTS,
  PLANS,
  ROLES,
  ROLE_PERMISSIONS,
} from "./data.js";

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
    const appIdByKey = new Map(appRows.map((a) => [a.key, a.id]));

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

    const planRows = await tx
      .insert(plans)
      .values(
        PLANS.map((p) => {
          const applicationId = appIdByKey.get(p.applicationKey);
          if (!applicationId) {
            throw new Error(`Seed error: application "${p.applicationKey}" was not upserted`);
          }
          return { applicationId, key: p.key, name: p.name, description: p.description };
        }),
      )
      .onConflictDoUpdate({
        target: [plans.applicationId, plans.key],
        set: { name: sql`excluded.name`, description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: plans.id, applicationId: plans.applicationId, key: plans.key });

    const planIdByAppIdAndKey = new Map(planRows.map((p) => [`${p.applicationId}:${p.key}`, p.id]));

    const planEntitlementRows = PLAN_ENTITLEMENTS.map((pe) => {
      const applicationId = appIdByKey.get(pe.applicationKey);
      if (!applicationId) {
        throw new Error(`Seed error: application "${pe.applicationKey}" was not upserted`);
      }
      const planId = planIdByAppIdAndKey.get(`${applicationId}:${pe.planKey}`);
      if (!planId) {
        throw new Error(`Seed error: plan "${pe.applicationKey}/${pe.planKey}" was not upserted`);
      }
      return { planId, key: pe.key, value: pe.value };
    });

    if (planEntitlementRows.length > 0) {
      await tx
        .insert(planEntitlements)
        .values(planEntitlementRows)
        .onConflictDoUpdate({
          target: [planEntitlements.planId, planEntitlements.key],
          set: { value: sql`excluded.value`, updatedAt: sql`now()` },
        });
    }

    return {
      applications: appRows.length,
      permissions: permRows.length,
      roles: roleRows.length,
      rolePermissions: rolePermissionRows.length,
      plans: planRows.length,
      planEntitlements: planEntitlementRows.length,
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
