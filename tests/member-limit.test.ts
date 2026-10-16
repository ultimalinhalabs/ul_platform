import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import { applications, memberships, planEntitlements, plans, roles, subscriptions } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { MemberLimitExceededError } from "../src/modules/memberships/memberLimit.js";
import { createMembership, updateMembership } from "../src/modules/memberships/service.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization } from "./helpers.js";

/**
 * The plan's `members.max` (owner-approved Na Pista Crescimento: 5 users per organization) enforced by UL
 * Platform on memberships. NA_PISTA/STARTER gets a temporary `members.max` for this run (removed afterwards:
 * other suites assert the seeded catalog).
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const createdOrgs: string[] = [];
let starterPlanId: string;
let actor: { id: string; email: string };

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setIssuer(EXPECTED_ISSUER).setExpirationTime("10m").sign(secret);
}

async function setStarterMembersMax(value: unknown) {
  await db.delete(planEntitlements).where(and(eq(planEntitlements.planId, starterPlanId), eq(planEntitlements.key, "members.max")));
  if (value !== undefined) await db.insert(planEntitlements).values({ planId: starterPlanId, key: "members.max", value });
}

/** An organization whose OWNER is `actor`, subscribed (or not) to NA_PISTA/STARTER. */
async function org(subscribed = true) {
  const o = await createTestOrganization("members-limit", actor.id);
  createdOrgs.push(o.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: actor.id, organizationId: o.id, roleId: ownerRole!.id, status: "active" });
  if (subscribed) await createSubscription({ organizationId: o.id, applicationKey: "NA_PISTA", planKey: "STARTER", actorUserId: actor.id });
  return o.id;
}
const add = async (organizationId: string, status: "active" | "invited" | "suspended" = "active") =>
  createMembership({ organizationId, userId: (await createTestUser("members-limit-user")).id, roleKey: "STAFF", status, actorUserId: actor.id, actorRoleKey: "OWNER" });
async function counted(organizationId: string) {
  const [r] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.organizationId, organizationId), inArray(memberships.status, ["active", "invited"])));
  return r!.n;
}

before(async () => {
  await seed();
  actor = await createTestUser("members-limit-owner");
  const [row] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "NA_PISTA"), eq(plans.key, "STARTER")));
  starterPlanId = row!.id;
  await setStarterMembersMax(3);
});

after(async () => {
  server.close();
  await setStarterMembersMax(undefined);
  for (const id of createdOrgs) await deleteTestOrganization(id);
  await queryClient.end();
});

test("the plan's members.max caps active + invited members (the OWNER counts); suspended members do not take a place", async () => {
  const o = await org();
  await add(o); // OWNER + 1
  await add(o, "invited"); // + 1 invited = 3
  await assert.rejects(() => add(o), (e: unknown) => e instanceof MemberLimitExceededError && /at most 3 members/.test((e as Error).message));
  await assert.rejects(() => add(o, "invited"), MemberLimitExceededError);
  await add(o, "suspended"); // allowed: grants no access
  assert.equal(await counted(o), 3);
});

test("reactivating a suspended member takes a place again; suspending one frees it", async () => {
  const o = await org();
  const a = await add(o);
  const s = await add(o, "suspended");
  await add(o); // 3 counted
  await assert.rejects(() => updateMembership({ organizationId: o, membershipId: s.id, status: "active", actorUserId: actor.id, actorRoleKey: "OWNER" }), MemberLimitExceededError);
  await updateMembership({ organizationId: o, membershipId: a.id, status: "suspended", actorUserId: actor.id, actorRoleKey: "OWNER" });
  await updateMembership({ organizationId: o, membershipId: s.id, status: "active", actorUserId: actor.id, actorRoleKey: "OWNER" });
  await updateMembership({ organizationId: o, membershipId: s.id, roleKey: "MANAGER", actorUserId: actor.id, actorRoleKey: "OWNER" }); // a role change never counts
  assert.equal(await counted(o), 3);
});

test("concurrent additions can never overshoot the limit", async () => {
  const o = await org();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => add(o)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "OWNER + 2 = 3");
  assert.equal(await counted(o), 3);
});

test("no effective plan with members.max → no limit; once the subscription ends the limit no longer applies; a downgrade removes nobody", async () => {
  const free = await org(false);
  for (let i = 0; i < 4; i++) await add(free);
  assert.equal(await counted(free), 5);

  const o = await org();
  await add(o);
  await add(o);
  await setStarterMembersMax(2); // downgrade below the current count
  try {
    await assert.rejects(() => add(o), MemberLimitExceededError);
    assert.equal(await counted(o), 3, "nobody removed");
  } finally {
    await setStarterMembersMax(3);
  }
  await db.execute(sql`update subscriptions set current_period_end = now() - interval '1 minute', current_period_start = now() - interval '31 days' where organization_id = ${o}`);
  await add(o); // the plan is no longer effective
  assert.equal(await counted(o), 4);
});

test("an invalid members.max fails closed", async () => {
  const o = await org();
  await setStarterMembersMax({ max: 5 }); // not a number
  try {
    await assert.rejects(() => add(o), MemberLimitExceededError);
  } finally {
    await setStarterMembersMax(3);
  }
});

test("over HTTP: POST /organizations/:id/memberships at the limit → 409 LIMIT_EXCEEDED", async () => {
  const o = await org();
  await add(o);
  await add(o);
  const user = await createTestUser("members-limit-http");
  const res = await fetch(`${base()}/organizations/${o}/memberships`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokenFor(actor)}`, "content-type": "application/json" },
    body: JSON.stringify({ userId: user.id, roleKey: "STAFF" }),
  });
  const json = (await res.json()) as { error?: { code?: string } };
  assert.equal(res.status, 409);
  assert.equal(json.error?.code, "LIMIT_EXCEEDED");
  const [subs] = await db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.organizationId, o));
  assert.equal(subs!.n, 1);
});
