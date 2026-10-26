import "dotenv/config";
import { assertLocalOnlyTargets } from "./localOnlyGuard.js";
import { closeFixtureDb, createFixtureOrganization, grantFixtureApplicationAccess, subscribeFixture } from "./fixtureSupport.js";

// Dev-only: refuses to run unless every target is local (see localOnlyGuard.ts).
assertLocalOnlyTargets({ database: true });
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";

/**
 * F23 fixture provisioning — same pattern as F19/F20/F21/F22's scripts
 * (see f19-provision-fixtures.ts's header for the full rationale, not
 * repeated here). Orders' E2E scope (F23 brief §41) reuses F19's proven
 * service-credential/entitlement/tenant-isolation mechanisms rather than
 * re-proving them, so this fixture set only needs what's genuinely new:
 * OWNER/MANAGER/STAFF roles for permission-mapping tests (orders.create/
 * update vs read-only), a second org for cross-tenant isolation, and an
 * unsubscribed org for entitlement-disabled tests. No new entitlement,
 * scope, or meter is introduced for Orders (reuses `catalog.enabled`/
 * `catalog.read`/`catalog.write`/`api_requests`, unchanged) — this
 * fixture set is deliberately identical in shape to F22's.
 *
 * Usage: npm run f23:provision   (requires `npm run dev` already running)
 */
async function main() {
  const { env } = await import("../src/config/env.js");
  const { EXPECTED_ISSUER } = await import("../src/integrations/supabase/jwt.js");

  const BASE = `http://127.0.0.1:${env.PORT}/v1`;
  const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

  async function mintUserToken(userId: string, email: string, ttl = "3h") {
    return new SignJWT({ email, aud: "authenticated", role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer(EXPECTED_ISSUER)
      .setExpirationTime(ttl)
      .sign(secret);
  }

  async function call(method: string, path: string, token: string | undefined, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: ReturnType<typeof JSON.parse>; error?: ReturnType<typeof JSON.parse> } | undefined;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error)}`);
    return json!.data;
  }

  const runId = randomUUID().slice(0, 8);
  const email = (label: string) => `f23-${label}+${randomUUID()}@test.ul-platform.invalid`;

  const ownerAId = randomUUID();
  const staffAId = randomUUID();
  const managerAId = randomUUID();
  const ownerBId = randomUUID();
  const ownerCId = randomUUID();

  const ownerAToken = await mintUserToken(ownerAId, email("owner-a"));
  const staffAToken = await mintUserToken(staffAId, email("staff-a"));
  const managerAToken = await mintUserToken(managerAId, email("manager-a"));
  const ownerBToken = await mintUserToken(ownerBId, email("owner-b"));
  const ownerCToken = await mintUserToken(ownerCId, email("owner-c"));

  await call("GET", "/me", staffAToken);
  await call("GET", "/me", managerAToken);

  const orgA = await createFixtureOrganization(BASE, ownerAToken, ownerAId, { name: `F23_TEST_ORG_A_${runId}` });
  const orgB = await createFixtureOrganization(BASE, ownerBToken, ownerBId, { name: `F23_TEST_ORG_B_${runId}` });
  const orgC = await createFixtureOrganization(BASE, ownerCToken, ownerCId, { name: `F23_TEST_ORG_C_${runId}` });

  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, { userId: staffAId, roleKey: "STAFF" });
  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, { userId: managerAId, roleKey: "MANAGER" });

  // Org A, B: active NA_PISTA/BUSINESS subscription -> catalog.enabled=true.
  // Org C: deliberately NO subscription -> entitlement-disabled scenarios. It still has application
  // access: its tests mint a NA_PISTA key at runtime ("credential valid, entitlement absent").
  const subscriptionA = await subscribeFixture(orgA.id, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  const subscriptionB = await subscribeFixture(orgB.id, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  await grantFixtureApplicationAccess(orgC.id, "NA_PISTA");

  const platformFacingA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });
  const integrationA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read", "catalog.write", "customer.read", "customer.write", "order.read", "order.write", "appointment.read", "appointment.write"],
  });
  const platformFacingB = await call("POST", `/organizations/${orgB.id}/api-keys`, ownerBToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });

  const fixtures = {
    createdAt: new Date().toISOString(),
    runId,
    platformBaseUrl: BASE,
    orgA: { id: orgA.id, slug: orgA.slug, ownerId: ownerAId, ownerToken: ownerAToken, subscriptionId: subscriptionA.id },
    orgB: { id: orgB.id, slug: orgB.slug, ownerId: ownerBId, ownerToken: ownerBToken, subscriptionId: subscriptionB.id },
    orgC: { id: orgC.id, slug: orgC.slug, ownerId: ownerCId, ownerToken: ownerCToken },
    staffA: { id: staffAId, token: staffAToken },
    managerA: { id: managerAId, token: managerAToken },
    apiKeys: {
      platformFacingA: { keyId: platformFacingA.id, secret: platformFacingA.secret, scopes: platformFacingA.scopes },
      integrationA: { keyId: integrationA.id, secret: integrationA.secret, scopes: integrationA.scopes },
      platformFacingB: { keyId: platformFacingB.id, secret: platformFacingB.secret, scopes: platformFacingB.scopes },
    },
  };

  const outPath = new URL("../../na-pista/.fixtures/f23-fixtures.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2), "utf8");
  console.log(`F23 fixtures written to ${outPath.pathname.replace(/^\//, "")}`);
  console.log(`orgA=${orgA.id} orgB=${orgB.id} orgC=${orgC.id}`);
}

main().finally(closeFixtureDb).catch((error) => {
  console.error("F23 fixture provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
