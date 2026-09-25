import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";

/**
 * F27 fixture provisioning — same pattern as F19-F26's scripts (see
 * f19-provision-fixtures.ts's header for the full rationale). Appointment
 * E2E (F27 brief §57) needs exactly what F26 needed: OWNER/MANAGER/STAFF
 * in org A (appointments.create/update vs read-only), a subscribed org B
 * (cross-tenant isolation), an unsubscribed org C (entitlement denied).
 * No new entitlement, scope, or meter is introduced for Appointments
 * (reuses `catalog.enabled`/`catalog.read`/`catalog.write`/`api_requests`,
 * unchanged) — dev-only test tooling, no UL Platform production change.
 *
 * Usage: npm run f27:provision   (requires `npm run dev` already running)
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
    const json = (await res.json().catch(() => undefined)) as { data?: any; error?: any } | undefined;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error)}`);
    return json!.data;
  }

  const runId = randomUUID().slice(0, 8);
  const email = (label: string) => `f27-${label}+${randomUUID()}@test.ul-platform.invalid`;

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

  const orgA = await call("POST", "/organizations", ownerAToken, { name: `F27_TEST_ORG_A_${runId}` });
  const orgB = await call("POST", "/organizations", ownerBToken, { name: `F27_TEST_ORG_B_${runId}` });
  const orgC = await call("POST", "/organizations", ownerCToken, { name: `F27_TEST_ORG_C_${runId}` });

  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, { userId: staffAId, roleKey: "STAFF" });
  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, { userId: managerAId, roleKey: "MANAGER" });

  // Org A, B: active NA_PISTA/BUSINESS subscription -> catalog.enabled=true.
  // Org C: deliberately NO subscription -> entitlement-disabled scenarios.
  const subscriptionA = await call("POST", `/organizations/${orgA.id}/subscriptions`, ownerAToken, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  const subscriptionB = await call("POST", `/organizations/${orgB.id}/subscriptions`, ownerBToken, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });

  const platformFacingA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });
  const integrationA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read", "catalog.write"],
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

  const outPath = new URL("../../na-pista/.fixtures/f27-fixtures.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2), "utf8");
  console.log(`F27 fixtures written to ${outPath.pathname.replace(/^\//, "")}`);
  console.log(`orgA=${orgA.id} orgB=${orgB.id} orgC=${orgC.id}`);
}

main().catch((error) => {
  console.error("F27 fixture provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
