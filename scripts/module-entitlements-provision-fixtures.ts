import "dotenv/config";
import { assertLocalOnlyTargets } from "./localOnlyGuard.js";

// Dev-only: refuses to run unless every target is local (see localOnlyGuard.ts).
assertLocalOnlyTargets({ database: true });
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";

/**
 * Audit 2026-10-20 / migration 0031 — fixtures for Na Pista's per-module entitlement E2E
 * (na-pista/tests/e2e/module-entitlements.test.ts). Same pattern as f19–f27, with two differences:
 *  - subscriptions are created with the service function, not POST /subscriptions (self-service is closed
 *    since 1590646 — PLAN_REQUIRES_CONTRACT); application access is granted the same way;
 *  - it creates two LOCAL test plans (TEST_MOD_*) validated against the typed definitions; the teardown
 *    removes them (UL's seed test counts catalog rows).
 *
 * Orgs: CAT = catalog only (products.max 10); SVC = customers + services only; ALL = BUSINESS (every module).
 * Usage: npm run dev (UL, local) → npx tsx scripts/module-entitlements-provision-fixtures.ts
 */
async function main() {
  const { env } = await import("../src/config/env.js");
  const { EXPECTED_ISSUER } = await import("../src/integrations/supabase/jwt.js");
  const { db, queryClient } = await import("../src/db/index.js");
  const { applications, planEntitlements, plans } = await import("../src/db/schema/index.js");
  const { eq, sql } = await import("drizzle-orm");
  const { loadDefinitions, validatePlanEntitlements } = await import("../src/modules/entitlements/definitions.js");
  const { createSubscription } = await import("../src/modules/subscriptions/service.js");
  const { grantApplicationAccess } = await import("../src/modules/applicationAccess/service.js");

  const BASE = `http://127.0.0.1:${env.PORT}/v1`;
  const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  const runId = randomUUID().slice(0, 8);

  async function mintUserToken(userId: string, email: string, ttl = "3h") {
    return new SignJWT({ email, aud: "authenticated", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(EXPECTED_ISSUER)
      .setExpirationTime(ttl)
      .sign(secret);
  }

  async function call(method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: ReturnType<typeof JSON.parse>; error?: ReturnType<typeof JSON.parse> } | undefined;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error)}`);
    return json!.data;
  }

  try {
    const [na] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, "NA_PISTA"));
    const defs = await loadDefinitions(db, "NA_PISTA");
    const testPlans: Record<string, Record<string, unknown>> = {
      TEST_MOD_CATALOG_ONLY: { "catalog.enabled": true, "products.max": 10, "orders.enabled": false, "customers.enabled": false, "services.enabled": false },
      TEST_MOD_SERVICES_ONLY: { "catalog.enabled": false, "orders.enabled": false, "customers.enabled": true, "services.enabled": true },
    };
    for (const [key, values] of Object.entries(testPlans)) {
      const check = validatePlanEntitlements(Object.entries(values).map(([k, value]) => ({ key: k, value })), defs);
      if (check.errors.length) throw new Error(`${key}: ${check.errors.join("; ")}`);
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('ul.actor', 'script:module-entitlements-fixtures', true)`);
        const [plan] = await tx
          .insert(plans)
          .values({ applicationId: na!.id, key, name: key, description: "LOCAL E2E fixture plan (teardown removes it)" })
          .onConflictDoUpdate({ target: [plans.applicationId, plans.key], set: { status: "ACTIVE" } })
          .returning();
        await tx.delete(planEntitlements).where(eq(planEntitlements.planId, plan!.id));
        await tx.insert(planEntitlements).values(Object.entries(values).map(([k, value]) => ({ planId: plan!.id, key: k, value })));
      });
    }

    async function org(label: string, planKey: string) {
      const userId = randomUUID();
      const email = `modent-${label}+${randomUUID()}@test.ul-platform.invalid`;
      const token = await mintUserToken(userId, email);
      await call("GET", "/me", token);
      await db.execute(sql`create schema if not exists auth`);
      await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
      await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${userId}, now()) on conflict (id) do update set email_confirmed_at = now()`);
      const o = await call("POST", "/organizations", token, { name: `MODENT_TEST_ORG_${label}_${runId}` }, { "idempotency-key": `modent-${randomUUID()}` });
      await grantApplicationAccess({ organizationId: o.id, applicationKey: "NA_PISTA", actorUserId: null });
      const subscription = await createSubscription({ organizationId: o.id, applicationKey: "NA_PISTA", planKey, actorUserId: null });
      const key = await call("POST", `/organizations/${o.id}/api-keys`, token, { applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] });
      return { id: o.id as string, ownerId: userId, ownerToken: token, subscriptionId: subscription.id, planKey, platformFacingKey: { keyId: key.id as string, secret: key.secret as string } };
    }

    const fixtures = {
      createdAt: new Date().toISOString(),
      runId,
      platformBaseUrl: BASE,
      orgCatalogOnly: await org("CAT", "TEST_MOD_CATALOG_ONLY"),
      orgServicesOnly: await org("SVC", "TEST_MOD_SERVICES_ONLY"),
      orgAll: await org("ALL", "BUSINESS"),
    };
    const outPath = new URL("../../na-pista/.fixtures/module-entitlements-fixtures.json", import.meta.url);
    writeFileSync(outPath, JSON.stringify(fixtures, null, 2), "utf8");
    console.log(`Module-entitlement fixtures written to ${outPath.pathname.replace(/^\//, "")}`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("Module-entitlement fixture provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
