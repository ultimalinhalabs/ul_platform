import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SignJWT } from "jose";

/**
 * F19 fixture provisioning — creates real, clearly-named test data in a
 * REAL, already-running UL Platform (real HTTP API, real database) for the
 * na-pista/spikes/platform-integration runtime spike.
 *
 * Deliberately lives in ul-platform/scripts, not in na-pista: it needs
 * SUPABASE_JWT_SECRET to mint test-user bearer tokens locally (the exact
 * technique scripts/smoke.ts already established as this repo's own
 * sanctioned no-real-Supabase-login test pattern), and that secret must
 * never leave this process. Everything after minting a token is a plain
 * HTTP call to this platform's own public API — exactly what any external
 * client (including the real na-pista spike) does. No direct DB writes
 * except the one cleanup step at teardown time, mirroring tests/helpers.ts.
 *
 * Output: a local, gitignored JSON file the na-pista spike's test harness
 * reads to get org ids, subscription ids, api key secrets and short-lived
 * user bearer tokens. Never committed, never printed in full to a log.
 *
 * Usage: npm run f19:provision   (requires the API already running on
 * env.PORT — start it separately with `npm run dev`)
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
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: any; error?: any } | undefined;
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error)}`);
    }
    return json!.data;
  }

  const runId = randomUUID().slice(0, 8);
  const email = (label: string) => `f19-${label}+${randomUUID()}@test.ul-platform.invalid`;

  // --- Users (fresh identities; platform `users` row is created lazily on
  // first authenticated request — see middleware/authenticate.ts) ---
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

  // Touch /me once for staffA/outsider so their `users` row exists before
  // being referenced as a membership target (membership.create requires
  // the target to have authenticated at least once — see README).
  await call("GET", "/me", staffAToken);
  await call("GET", "/me", outsiderToken);

  // --- Organizations (createOrganization makes the caller OWNER atomically) ---
  const orgA = await call("POST", "/organizations", ownerAToken, { name: `F19_TEST_ORG_A_${runId}` });
  const orgB = await call("POST", "/organizations", ownerBToken, { name: `F19_TEST_ORG_B_${runId}` });
  const orgC = await call("POST", "/organizations", ownerCToken, { name: `F19_TEST_ORG_C_${runId}` });
  // Org D: mirrors org A (also subscribed+entitled) — needed so
  // tenant-isolation tests can prove "two organizations that BOTH have
  // real access are still isolated from each other", independent of the
  // entitlement-gating scenarios org B/C exist for.
  const orgD = await call("POST", "/organizations", ownerDToken, { name: `F19_TEST_ORG_D_${runId}` });
  // Org E: exists ONLY for the entitlements test file's live
  // subscribe->cancel->observe-cache scenario. No other test file may
  // touch org E's subscription — a shared mutable fixture across files
  // would make results depend on file execution order.
  const ownerEId = randomUUID();
  const ownerEToken = await mintUserToken(ownerEId, email("owner-e"));
  const orgE = await call("POST", "/organizations", ownerEToken, { name: `F19_TEST_ORG_E_${runId}` });

  // --- Membership: staffA is STAFF in org A only (for permission + cross-tenant tests) ---
  await call("POST", `/organizations/${orgA.id}/memberships`, ownerAToken, {
    userId: staffAId,
    roleKey: "STAFF",
  });

  // --- Subscriptions ---
  // Org A: active NA_PISTA/BUSINESS subscription -> granting entitlements.
  const subscriptionA = await call("POST", `/organizations/${orgA.id}/subscriptions`, ownerAToken, {
    applicationKey: "NA_PISTA",
    planKey: "BUSINESS",
  });
  // Org B: deliberately NO subscription -> entitlements must resolve empty.
  // Org C: subscribe then cancel -> "canceled subscription" must behave like "no access".
  const subscriptionC = await call("POST", `/organizations/${orgC.id}/subscriptions`, ownerCToken, {
    applicationKey: "NA_PISTA",
    planKey: "STARTER",
  });
  await call("PATCH", `/organizations/${orgC.id}/subscriptions/${subscriptionC.id}`, ownerCToken, {
    status: "canceled",
  });
  const subscriptionD = await call("POST", `/organizations/${orgD.id}/subscriptions`, ownerDToken, {
    applicationKey: "NA_PISTA",
    planKey: "BUSINESS",
  });
  const subscriptionE = await call("POST", `/organizations/${orgE.id}/subscriptions`, ownerEToken, {
    applicationKey: "NA_PISTA",
    planKey: "BUSINESS",
  });

  // --- API keys (org-scoped, NA_PISTA) ---
  // Two classes per authorization.md §3.1: "integration" (data scopes) vs
  // "platform-facing" (usage.write/event.publish) — never the same key.
  const integrationKeyA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read", "catalog.write", "customer.read"],
  });
  const platformFacingKeyA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });
  const noScopeKeyA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: [],
  });
  const expiredKeyA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read"],
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const toRevokeKeyA = await call("POST", `/organizations/${orgA.id}/api-keys`, ownerAToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read"],
  });
  await call("POST", `/organizations/${orgA.id}/api-keys/${toRevokeKeyA.id}/revoke`, ownerAToken);

  // Org B: an API key can be minted even without a subscription (creation
  // only requires membership + api_key.manage, not entitlement) — this is
  // exactly the fixture needed for "credential valid, entitlement absent".
  const integrationKeyB = await call("POST", `/organizations/${orgB.id}/api-keys`, ownerBToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read", "catalog.write", "customer.read"],
  });
  const platformFacingKeyD = await call("POST", `/organizations/${orgD.id}/api-keys`, ownerDToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });
  const integrationKeyD = await call("POST", `/organizations/${orgD.id}/api-keys`, ownerDToken, {
    applicationKey: "NA_PISTA",
    scopes: ["catalog.read", "catalog.write", "customer.read"],
  });
  const platformFacingKeyE = await call("POST", `/organizations/${orgE.id}/api-keys`, ownerEToken, {
    applicationKey: "NA_PISTA",
    scopes: ["usage.write", "event.publish"],
  });

  const fixtures = {
    createdAt: new Date().toISOString(),
    runId,
    platformBaseUrl: BASE,
    orgA: { id: orgA.id, slug: orgA.slug, ownerId: ownerAId, ownerToken: ownerAToken, subscriptionId: subscriptionA.id },
    orgB: { id: orgB.id, slug: orgB.slug, ownerId: ownerBId, ownerToken: ownerBToken },
    orgC: { id: orgC.id, slug: orgC.slug, ownerId: ownerCId, ownerToken: ownerCToken, subscriptionId: subscriptionC.id },
    orgD: { id: orgD.id, slug: orgD.slug, ownerId: ownerDId, ownerToken: ownerDToken, subscriptionId: subscriptionD.id },
    orgE: { id: orgE.id, slug: orgE.slug, ownerId: ownerEId, ownerToken: ownerEToken, subscriptionId: subscriptionE.id },
    staffA: { id: staffAId, token: staffAToken },
    outsider: { id: outsiderId, token: outsiderToken },
    apiKeys: {
      integrationA: { keyId: integrationKeyA.id, secret: integrationKeyA.secret, scopes: integrationKeyA.scopes },
      platformFacingA: { keyId: platformFacingKeyA.id, secret: platformFacingKeyA.secret, scopes: platformFacingKeyA.scopes },
      noScopeA: { keyId: noScopeKeyA.id, secret: noScopeKeyA.secret, scopes: noScopeKeyA.scopes },
      expiredA: { keyId: expiredKeyA.id, secret: expiredKeyA.secret, scopes: expiredKeyA.scopes },
      revokedA: { keyId: toRevokeKeyA.id, secret: toRevokeKeyA.secret, scopes: toRevokeKeyA.scopes },
      integrationB: { keyId: integrationKeyB.id, secret: integrationKeyB.secret, scopes: integrationKeyB.scopes },
      platformFacingD: { keyId: platformFacingKeyD.id, secret: platformFacingKeyD.secret, scopes: platformFacingKeyD.scopes },
      integrationD: { keyId: integrationKeyD.id, secret: integrationKeyD.secret, scopes: integrationKeyD.scopes },
      platformFacingE: { keyId: platformFacingKeyE.id, secret: platformFacingKeyE.secret, scopes: platformFacingKeyE.scopes },
    },
  };

  const outPath = new URL("../../na-pista/spikes/platform-integration/.fixtures/f19-fixtures.json", import.meta.url);
  writeFileSync(outPath, JSON.stringify(fixtures, null, 2), "utf8");
  console.log(`F19 fixtures written to ${outPath.pathname.replace(/^\//, "")}`);
  console.log(`orgA=${orgA.id} orgB=${orgB.id} orgC=${orgC.id} orgD=${orgD.id}`);
}

main().catch((error) => {
  console.error("F19 fixture provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
