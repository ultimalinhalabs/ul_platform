import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";

/**
 * F20 fixture provisioning — same pattern as F19's
 * (scripts/f19-provision-fixtures.ts): real HTTP calls to a real,
 * already-running UL Platform, real database. SUPABASE_JWT_SECRET never
 * leaves this process. See that script's header comment for the full
 * rationale (this one is deliberately not re-explained line by line).
 *
 * Usage: npm run f20:provision   (requires `npm run dev` already running)
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
  const email = (label: string) => `f20-${label}+${randomUUID()}@test.ul-platform.invalid`;

  const ownerAId = randomUUID();
  const ownerBId = randomUUID();
  const ownerCId = randomUUID();
  const ownerDId = randomUUID();
  const staffAId = randomUUID();
  const outsiderId = randomUUID();

  const ownerAToken = await mintUserToken(ownerAId, email("owner-a"));
  const ownerBToken = await mintUserToken(ownerBId, email("owner-b"));
  const ownerCToken = await mintUserToken(ownerCId, email("owner-c"));
  const ownerDToken = await mintUserToken(ownerDId, email("owner-d"));
  const staffAToken = await mintUserToken(staffAId, email("staff-a"));
  const outsiderToken = await mintUserToken(outsiderId, email("outsider"));

  // Ensure `users` rows exist before being referenced as membership targets.
  await call("GET", "/me", staffAToken);
  await call("GET", "/me", outsiderToken);

  const orgA = await call("POST", "/organizations", ownerAToken, { name: `F20_TEST_ORG_A_${runId}` });
  const orgB = await call("POST", "/organizations", ownerBToken, { name: `F20_TEST_ORG_B_${runId}` });
  const orgC = await call("POST", "/organizations", ownerCToken, { name: `F20_TEST_ORG_C_${runId}` });
  const orgD = await call("POST", "/organizations", ownerDToken, { name: `F20_TEST_ORG_D_${runId}` });

  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, { userId: staffAId, roleKey: "STAFF" });

  // Org A, B, D: active NA_PISTA/BUSINESS subscription -> catalog.enabled=true, products.max=1000.
  // Org C: deliberately NO subscription -> entitlement-disabled scenarios.
  const subscriptionA = await call("POST", `/organizations/${orgA.id}/subscriptions`, ownerAToken, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  const subscriptionB = await call("POST", `/organizations/${orgB.id}/subscriptions`, ownerBToken, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
  const subscriptionD = await call("POST", `/organizations/${orgD.id}/subscriptions`, ownerDToken, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });

  // Org A: one org-scoped NA_PISTA key per credential class (OD-11/authorization.md §3.1) —
  // platform-facing (Na Pista's own outbound calls) and integration (a tenant's own client, inbound).
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
  const platformFacingD = await call("POST", `/organizations/${orgD.id}/api-keys`, ownerDToken, {
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
    orgD: { id: orgD.id, slug: orgD.slug, ownerId: ownerDId, ownerToken: ownerDToken, subscriptionId: subscriptionD.id },
    staffA: { id: staffAId, token: staffAToken },
    outsider: { id: outsiderId, token: outsiderToken },
    apiKeys: {
      platformFacingA: { keyId: platformFacingA.id, secret: platformFacingA.secret, scopes: platformFacingA.scopes },
      integrationA: { keyId: integrationA.id, secret: integrationA.secret, scopes: integrationA.scopes },
      platformFacingB: { keyId: platformFacingB.id, secret: platformFacingB.secret, scopes: platformFacingB.scopes },
      platformFacingD: { keyId: platformFacingD.id, secret: platformFacingD.secret, scopes: platformFacingD.scopes },
    },
  };

  const outPath = new URL("../../na-pista/.fixtures/f20-fixtures.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2), "utf8");
  console.log(`F20 fixtures written to ${outPath.pathname.replace(/^\//, "")}`);
  console.log(`orgA=${orgA.id} orgB=${orgB.id} orgC=${orgC.id} orgD=${orgD.id}`);
}

main().catch((error) => {
  console.error("F20 fixture provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
