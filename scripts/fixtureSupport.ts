import { randomUUID } from "node:crypto";

/**
 * Shared by the f19–f27 fixture scripts (Na Pista e2e suites). Two platform rules made the original scripts fail:
 *  - POST /organizations needs a verified email (auth.users, never user_metadata) and an Idempotency-Key;
 *  - a plan subscription is no longer self-service (POST /subscriptions → 403 PLAN_REQUIRES_CONTRACT since 1590646).
 * Fixtures therefore mark the minted test user as verified in the LOCAL auth.users and create the subscription with
 * the service function contract activation uses — the same pattern as module-entitlements-provision-fixtures.ts.
 *
 * Every import is dynamic: callers run assertLocalOnlyTargets() first, before anything reads the database config.
 */
export async function markFixtureEmailVerified(userId: string) {
  const { db } = await import("../src/db/index.js");
  const { sql } = await import("drizzle-orm");
  // A plain local Postgres has no Supabase `auth` schema; create the minimum isEmailVerified reads.
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${userId}, now()) on conflict (id) do update set email_confirmed_at = now()`);
}

export async function createFixtureOrganization(base: string, token: string, userId: string, body: { name: string }) {
  await markFixtureEmailVerified(userId);
  const res = await fetch(`${base}/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": `fixture-${randomUUID()}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => undefined)) as { data?: ReturnType<typeof JSON.parse>; error?: ReturnType<typeof JSON.parse> } | undefined;
  if (!res.ok) throw new Error(`POST /organizations -> ${res.status} ${JSON.stringify(json?.error)}`);
  return json!.data;
}

/** Application access alone: an API key for the application needs it, a subscription does not come with it. */
export async function grantFixtureApplicationAccess(organizationId: string, applicationKey: string) {
  const { grantApplicationAccess } = await import("../src/modules/applicationAccess/service.js");
  await grantApplicationAccess({ organizationId, applicationKey, actorUserId: null });
}

/** Application access + subscription, as contract activation grants them (no contract: fixture plans only). */
export async function subscribeFixture(organizationId: string, input: { applicationKey: string; planKey: string }) {
  const { createSubscription } = await import("../src/modules/subscriptions/service.js");
  await grantFixtureApplicationAccess(organizationId, input.applicationKey);
  return createSubscription({ organizationId, ...input, actorUserId: null });
}

/**
 * Subscribed organizations with a platform-facing NA_PISTA key and nothing else (no timezone, no data), made ahead
 * of time for tests that need a FRESH organization: a test can no longer subscribe one itself (not self-service).
 * Named `<prefix>_FRESH<n>_…` so the matching teardown's `<prefix>_%` pattern removes them.
 */
export async function provisionFreshSubscribedOrgs(base: string, owner: { id: string; token: string }, namePrefix: string, count: number) {
  const fresh = [];
  for (let i = 1; i <= count; i++) {
    const org = await createFixtureOrganization(base, owner.token, owner.id, { name: `${namePrefix}_FRESH${i}_${randomUUID().slice(0, 8)}` });
    await subscribeFixture(org.id, { applicationKey: "NA_PISTA", planKey: "BUSINESS" });
    const res = await fetch(`${base}/organizations/${org.id}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] }),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: ReturnType<typeof JSON.parse>; error?: ReturnType<typeof JSON.parse> } | undefined;
    if (!res.ok) throw new Error(`POST /organizations/${org.id}/api-keys -> ${res.status} ${JSON.stringify(json?.error)}`);
    fresh.push({ id: org.id as string, ownerToken: owner.token, platformFacingKey: { keyId: json!.data.id as string, secret: json!.data.secret as string } });
  }
  return fresh;
}

/** A LOCAL platform admin (same insert as scripts/smoke.ts): grants/revokes application access through the real API. */
export async function makeFixturePlatformAdmin(userId: string) {
  const { db } = await import("../src/db/index.js");
  const { platformMemberships, platformRoles } = await import("../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const [role] = await db.select({ id: platformRoles.id }).from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  if (!role) throw new Error("PLATFORM_ADMIN role not seeded");
  await db.insert(platformMemberships).values({ userId, platformRoleId: role.id });
}

export async function closeFixtureDb() {
  const { queryClient } = await import("../src/db/index.js");
  await queryClient.end();
}
