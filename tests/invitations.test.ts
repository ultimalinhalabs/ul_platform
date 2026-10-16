import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, count, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import { applications, memberships, organizationInvitations, organizations, planEntitlements, plans, roles } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization } from "./helpers.js";

/**
 * Migration 0025 — team invitations by email, over HTTP: who may invite/revoke, duplicates and existing
 * members, acceptance only by the invited VERIFIED email (case-insensitive), decline/revoke/expiry, the
 * plan's members.max (pending invitations reserve a place), suspended organizations, concurrency.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const createdOrgs: string[] = [];
const authUsers: string[] = [];
let starterPlanId: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies vary per assertion
type Res = { status: number; data: any; code?: string };

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setIssuer(EXPECTED_ISSUER).setExpirationTime("10m").sign(secret);
}
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code?: string } } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code };
}
async function person(prefix: string, verified = true) {
  const user = await createTestUser(`inv-${prefix}`);
  authUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, ${verified ? sql`now()` : null})`);
  return { user, token: await tokenFor(user) };
}
async function member(userId: string, organizationId: string, roleKey: string) {
  const [role] = await db.select().from(roles).where(eq(roles.key, roleKey));
  await db.insert(memberships).values({ userId, organizationId, roleId: role!.id, status: "active" });
}
async function orgWithOwner() {
  const owner = await person("owner");
  const o = await createTestOrganization("inv-org", owner.user.id);
  createdOrgs.push(o.id);
  await member(owner.user.id, o.id, "OWNER");
  return { owner, orgId: o.id };
}
const invite = (orgId: string, token: string, email: string, roleKey = "STAFF") => call("POST", `/organizations/${orgId}/invitations`, token, { email, roleKey });

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  const [row] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "NA_PISTA"), eq(plans.key, "STARTER")));
  starterPlanId = row!.id;
});

after(async () => {
  server.close();
  await db.delete(planEntitlements).where(and(eq(planEntitlements.planId, starterPlanId), eq(planEntitlements.key, "members.max")));
  for (const id of createdOrgs) await deleteTestOrganization(id);
  for (const id of authUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

test("who may invite: OWNER and ADMIN; never STAFF; only an OWNER may invite an OWNER; outsiders cannot", async () => {
  const { owner, orgId } = await orgWithOwner();
  const admin = await person("admin");
  await member(admin.user.id, orgId, "ADMIN");
  const staff = await person("staff");
  await member(staff.user.id, orgId, "STAFF");
  const outsider = await person("outsider");
  assert.equal((await invite(orgId, owner.token, "nova.pessoa@example.com")).status, 201);
  assert.equal((await invite(orgId, admin.token, "outra.pessoa@example.com", "MANAGER")).status, 201);
  assert.equal((await invite(orgId, staff.token, "x@example.com")).status, 403);
  assert.equal((await invite(orgId, admin.token, "dono@example.com", "OWNER")).status, 403);
  assert.equal((await invite(orgId, owner.token, "dono@example.com", "OWNER")).status, 201);
  assert.ok([403, 404].includes((await invite(orgId, outsider.token, "y@example.com")).status));
  assert.equal((await invite(orgId, owner.token, "not-an-email")).status, 400);
  const list = await call("GET", `/organizations/${orgId}/invitations`, staff.token);
  assert.equal(list.status, 200, "membership.read lists them");
  assert.equal(list.data.length, 3);
});

test("no duplicates: one pending invitation per email; an existing member's email is ALREADY_MEMBER; emails are case-insensitive", async () => {
  const { owner, orgId } = await orgWithOwner();
  const existing = await person("existing");
  await member(existing.user.id, orgId, "STAFF");
  const first = await invite(orgId, owner.token, "Ana.Silva@Example.com");
  assert.equal(first.status, 201);
  assert.equal(first.data.email, "ana.silva@example.com");
  const dup = await invite(orgId, owner.token, "ana.silva@EXAMPLE.com");
  assert.equal(dup.status, 409);
  assert.equal(dup.code, "INVITATION_PENDING");
  const already = await invite(orgId, owner.token, existing.user.email.toUpperCase());
  assert.equal(already.status, 409);
  assert.equal(already.code, "ALREADY_MEMBER");
});

test("the invitee — and only the invitee, with a verified email — sees and accepts it: an active membership with the invited role", async () => {
  const { owner, orgId } = await orgWithOwner();
  const invitee = await person("invitee");
  const stranger = await person("stranger");
  const inv = await invite(orgId, owner.token, invitee.user.email.toUpperCase(), "MANAGER");
  assert.equal(inv.status, 201);

  const mine = await call("GET", "/me/invitations", invitee.token);
  assert.equal(mine.data.emailVerified, true);
  assert.equal(mine.data.invitations.length, 1);
  assert.equal(mine.data.invitations[0].organization.id, orgId);
  assert.equal(mine.data.invitations[0].roleKey, "MANAGER");
  assert.equal((await call("GET", "/me/invitations", stranger.token)).data.invitations.length, 0);
  assert.equal((await call("POST", `/me/invitations/${inv.data.id}/accept`, stranger.token)).status, 404, "not theirs: not found");

  const accepted = await call("POST", `/me/invitations/${inv.data.id}/accept`, invitee.token);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.roleKey, "MANAGER");
  const [m] = await db.select({ status: memberships.status, roleKey: roles.key }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId)).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, invitee.user.id)));
  assert.deepEqual(m, { status: "active", roleKey: "MANAGER" });
  assert.equal((await call("POST", `/me/invitations/${inv.data.id}/accept`, invitee.token)).status, 200, "accepting again is idempotent");
  const me = await call("GET", "/me", invitee.token);
  assert.ok(me.data.memberships.some((x: { organizationId: string }) => x.organizationId === orgId));
  const list = await call("GET", `/organizations/${orgId}/invitations`, owner.token);
  assert.equal(list.data.find((i: { id: string }) => i.id === inv.data.id).status, "accepted");
});

test("an unverified email can neither see nor accept invitations (EMAIL_NOT_VERIFIED)", async () => {
  const { owner, orgId } = await orgWithOwner();
  const unverified = await person("unverified", false);
  const inv = await invite(orgId, owner.token, unverified.user.email);
  const mine = await call("GET", "/me/invitations", unverified.token);
  assert.deepEqual(mine.data, { emailVerified: false, invitations: [] });
  const res = await call("POST", `/me/invitations/${inv.data.id}/accept`, unverified.token);
  assert.equal(res.status, 403);
  assert.equal(res.code, "EMAIL_NOT_VERIFIED");
});

test("decline, revoke and expiry end an invitation; a stale one does not block a new invitation", async () => {
  const { owner, orgId } = await orgWithOwner();
  const a = await person("decliner");
  const b = await person("revoked");
  const c = await person("expired");
  const ia = await invite(orgId, owner.token, a.user.email);
  assert.equal((await call("POST", `/me/invitations/${ia.data.id}/decline`, a.token)).status, 200);
  assert.equal((await call("POST", `/me/invitations/${ia.data.id}/accept`, a.token)).status, 409);
  const ib = await invite(orgId, owner.token, b.user.email);
  assert.equal((await call("POST", `/organizations/${orgId}/invitations/${ib.data.id}/revoke`, owner.token)).status, 200);
  assert.equal((await call("GET", "/me/invitations", b.token)).data.invitations.length, 0);
  assert.equal((await call("POST", `/me/invitations/${ib.data.id}/accept`, b.token)).status, 409);
  const ic = await invite(orgId, owner.token, c.user.email);
  await db.execute(sql`update organization_invitations set created_at = now() - interval '9 days', expires_at = now() - interval '1 day' where id = ${ic.data.id}`);
  assert.equal((await call("GET", "/me/invitations", c.token)).data.invitations.length, 0);
  const expired = await call("POST", `/me/invitations/${ic.data.id}/accept`, c.token);
  assert.equal(expired.status, 409);
  assert.equal((await invite(orgId, owner.token, c.user.email)).status, 201, "re-invite after expiry");
  assert.equal((await invite(orgId, owner.token, a.user.email)).status, 201, "re-invite after decline");
});

test("the plan's members.max counts pending invitations (no overbooking); accepting converts the reserved place", async () => {
  const { owner, orgId } = await orgWithOwner();
  await db.insert(planEntitlements).values({ planId: starterPlanId, key: "members.max", value: 3 }).onConflictDoNothing();
  await createSubscription({ organizationId: orgId, applicationKey: "NA_PISTA", planKey: "STARTER", actorUserId: owner.user.id });
  const p1 = await person("seat-1");
  const p2 = await person("seat-2");
  const i1 = await invite(orgId, owner.token, p1.user.email);
  const i2 = await invite(orgId, owner.token, p2.user.email);
  assert.equal(i1.status, 201);
  assert.equal(i2.status, 201);
  const full = await invite(orgId, owner.token, "terceiro@example.com");
  assert.equal(full.status, 409);
  assert.equal(full.code, "LIMIT_EXCEEDED");
  assert.equal((await call("POST", `/me/invitations/${i1.data.id}/accept`, p1.token)).status, 201, "its own place, not a new one");
  assert.equal((await call("POST", `/organizations/${orgId}/invitations/${i2.data.id}/revoke`, owner.token)).status, 200);
  assert.equal((await invite(orgId, owner.token, "terceiro@example.com")).status, 201, "a revoked invitation frees its place");
});

test("a suspended organization cannot be joined; concurrent accepts create one membership", async () => {
  const { owner, orgId } = await orgWithOwner();
  const p = await person("concurrent");
  const inv = await invite(orgId, owner.token, p.user.email);
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgId));
  assert.equal((await call("POST", `/me/invitations/${inv.data.id}/accept`, p.token)).code, "ORGANIZATION_SUSPENDED");
  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgId));
  const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", `/me/invitations/${inv.data.id}/accept`, p.token)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  const [n] = await db.select({ n: count() }).from(memberships).where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, p.user.id)));
  assert.equal(n!.n, 1);
  const [row] = await db.select({ status: organizationInvitations.status }).from(organizationInvitations).where(eq(organizationInvitations.id, inv.data.id));
  assert.equal(row!.status, "accepted");
});
