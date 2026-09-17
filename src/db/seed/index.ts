import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { db } from "../index.js";
import { validateEndpointUrl } from "../../modules/endpoints/validation.js";
import {
  applicationEndpoints,
  applicationEnvironments,
  applicationIntegrations,
  applicationMeters,
  applicationServiceScopes,
  applications,
  meters,
  permissions,
  planEntitlements,
  plans,
  rolePermissions,
  roles,
  serviceScopes,
} from "../schema/index.js";
import {
  APPLICATION_ENDPOINTS,
  APPLICATION_ENVIRONMENTS,
  APPLICATION_INTEGRATIONS,
  APPLICATION_METERS,
  APPLICATION_SERVICE_SCOPES,
  APPLICATIONS,
  METERS,
  PERMISSIONS,
  PLAN_ENTITLEMENTS,
  PLANS,
  ROLES,
  ROLE_PERMISSIONS,
  SERVICE_SCOPES,
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

    const serviceScopeRows = await tx
      .insert(serviceScopes)
      .values(SERVICE_SCOPES.map((s) => ({ ...s })))
      .onConflictDoUpdate({
        target: serviceScopes.key,
        set: { description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: serviceScopes.id, key: serviceScopes.key });

    const scopeIdByKey = new Map(serviceScopeRows.map((s) => [s.key, s.id]));

    const applicationServiceScopeRows = Object.entries(APPLICATION_SERVICE_SCOPES).flatMap(
      ([applicationKey, scopeKeys]) => {
        const applicationId = appIdByKey.get(applicationKey);
        if (!applicationId) {
          throw new Error(`Seed error: application "${applicationKey}" was not upserted`);
        }
        return scopeKeys.map((scopeKey) => {
          const serviceScopeId = scopeIdByKey.get(scopeKey);
          if (!serviceScopeId) throw new Error(`Seed error: service scope "${scopeKey}" was not upserted`);
          return { applicationId, serviceScopeId };
        });
      },
    );

    if (applicationServiceScopeRows.length > 0) {
      await tx
        .insert(applicationServiceScopes)
        .values(applicationServiceScopeRows)
        .onConflictDoNothing({
          target: [applicationServiceScopes.applicationId, applicationServiceScopes.serviceScopeId],
        });
    }

    const meterRows = await tx
      .insert(meters)
      .values(METERS.map((m) => ({ ...m })))
      .onConflictDoUpdate({
        target: meters.key,
        set: { unit: sql`excluded.unit`, description: sql`excluded.description`, updatedAt: sql`now()` },
      })
      .returning({ id: meters.id, key: meters.key });

    const meterIdByKey = new Map(meterRows.map((m) => [m.key, m.id]));

    const applicationMeterRows = Object.entries(APPLICATION_METERS).flatMap(([applicationKey, meterKeys]) => {
      const applicationId = appIdByKey.get(applicationKey);
      if (!applicationId) {
        throw new Error(`Seed error: application "${applicationKey}" was not upserted`);
      }
      return meterKeys.map((meterKey) => {
        const meterId = meterIdByKey.get(meterKey);
        if (!meterId) throw new Error(`Seed error: meter "${meterKey}" was not upserted`);
        return { applicationId, meterId };
      });
    });

    if (applicationMeterRows.length > 0) {
      await tx
        .insert(applicationMeters)
        .values(applicationMeterRows)
        .onConflictDoNothing({
          target: [applicationMeters.applicationId, applicationMeters.meterId],
        });
    }

    const environmentRows = await tx
      .insert(applicationEnvironments)
      .values(
        Object.entries(APPLICATION_ENVIRONMENTS).flatMap(([applicationKey, envKeys]) => {
          const applicationId = appIdByKey.get(applicationKey);
          if (!applicationId) throw new Error(`Seed error: application "${applicationKey}" was not upserted`);
          return envKeys.map((key) => ({ applicationId, key }));
        }),
      )
      .onConflictDoUpdate({
        target: [applicationEnvironments.applicationId, applicationEnvironments.key],
        set: { updatedAt: sql`now()` },
      })
      .returning({ id: applicationEnvironments.id, applicationId: applicationEnvironments.applicationId, key: applicationEnvironments.key });

    const environmentIdByAppIdAndKey = new Map(environmentRows.map((e) => [`${e.applicationId}:${e.key}`, e.id]));

    // Validated the same way a real admin submission would be — seed data
    // is not exempt from the rules `modules/endpoints/validation.ts` enforces.
    for (const endpoint of APPLICATION_ENDPOINTS) validateEndpointUrl(endpoint.baseUrl, endpoint.environmentKey);

    const endpointRows = APPLICATION_ENDPOINTS.map((e) => {
      const applicationId = appIdByKey.get(e.applicationKey);
      if (!applicationId) throw new Error(`Seed error: application "${e.applicationKey}" was not upserted`);
      const environmentId = environmentIdByAppIdAndKey.get(`${applicationId}:${e.environmentKey}`);
      if (!environmentId) {
        throw new Error(`Seed error: environment "${e.applicationKey}/${e.environmentKey}" was not upserted`);
      }
      return { environmentId, type: e.type, baseUrl: e.baseUrl };
    });

    if (endpointRows.length > 0) {
      await tx
        .insert(applicationEndpoints)
        .values(endpointRows)
        .onConflictDoUpdate({
          target: [applicationEndpoints.environmentId, applicationEndpoints.type],
          set: { baseUrl: sql`excluded.base_url`, updatedAt: sql`now()` },
        });
    }

    const integrationRows = APPLICATION_INTEGRATIONS.map((i) => {
      const sourceApplicationId = appIdByKey.get(i.sourceApplicationKey);
      if (!sourceApplicationId) {
        throw new Error(`Seed error: application "${i.sourceApplicationKey}" was not upserted`);
      }
      const targetApplicationId = appIdByKey.get(i.targetApplicationKey);
      if (!targetApplicationId) {
        throw new Error(`Seed error: application "${i.targetApplicationKey}" was not upserted`);
      }
      return { sourceApplicationId, targetApplicationId, description: i.description };
    });

    if (integrationRows.length > 0) {
      await tx
        .insert(applicationIntegrations)
        .values(integrationRows)
        .onConflictDoUpdate({
          target: [applicationIntegrations.sourceApplicationId, applicationIntegrations.targetApplicationId],
          set: { description: sql`excluded.description`, updatedAt: sql`now()` },
        });
    }

    return {
      applications: appRows.length,
      permissions: permRows.length,
      roles: roleRows.length,
      rolePermissions: rolePermissionRows.length,
      plans: planRows.length,
      planEntitlements: planEntitlementRows.length,
      serviceScopes: serviceScopeRows.length,
      applicationServiceScopes: applicationServiceScopeRows.length,
      meters: meterRows.length,
      applicationMeters: applicationMeterRows.length,
      environments: environmentRows.length,
      endpoints: endpointRows.length,
      integrations: integrationRows.length,
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
