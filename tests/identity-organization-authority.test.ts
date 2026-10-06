import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import { auditLogs, membershipApplicationRoles, memberships, platformMemberships, platformRoles, roles } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey } from "../src/modules/apiKeys/service.js";
import { resolveEffectiveApplicationRole } from "../src/modules/applicationRoles/effectiveRole.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

/**
 * Fase 6 — identity & organization authority, end to end over HTTP:
 * user/org status guards, cross-organization isolation, the enriched
 * /v1/me contract, application access separated from billing, and
 * per-application roles (explicit + documented fallback).
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

async function tokenFor(user: { id: string; email: string }, expiresIn = "10m") {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime(expiresIn)
    .sign(secret);
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code?: string } } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code };
}

type MeMembership = {
  organizationId: string;
  organizationName: string;
  roleKey: string;
  status: string;
  organization: { id: string; name: string; slug: string; status: string };
  applications: Array<{ key: string; roleKey: string | null; roleSource: string | null }>;
};
type Me = { userId: string; status: string; emailVerified: boolean; memberships: MeMembership[] };
const meOf = (r: { data: unknown }) => r.data as Me;
const membershipIn = (r: { data: unknown }, organizationId: string) => meOf(r).memberships.find((x) => x.organizationId === organizationId)!;
const rows = <T>(r: { data: unknown }) => r.data as T[];

async function user(prefix: string) {
  const u = await createTestUser(prefix);
  createdUsers.push(u.id);
  return u;
}

async function org(prefix: string, ownerId: string) {
  const o = await createTestOrganization(prefix, ownerId);
  createdOrgs.push(o.id);
  return o;
}

async function addMember(userId: string, organizationId: string, roleKey: string, status: "active" | "suspended" = "active") {
  const [role] = await db.select().from(roles).where(eq(roles.key, roleKey));
  const [m] = await db.insert(memberships).values({ userId, organizationId, roleId: role!.id, status }).returning();
  return m!;
}

let platformAdmin: { id: string; email: string };

before(async () => {
  await seed();
  // A Supabase project has auth.users; disposable/CI databases don't. Provide the minimal shape so
  // emailVerified (read server-side from auth.users.email_confirmed_at) is testable.
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  platformAdmin = await user("p6-platform-admin");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: platformAdmin.id, platformRoleId: role!.id, status: "ACTIVE" });
});

after(async () => {
  server.close();
  for (const id of createdOrgs) await deleteTestOrganization(id);
  for (const id of createdUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  for (const id of createdUsers) await deleteTestUser(id);
  await queryClient.end();
});

test("pure fallback: explicit role wins, QD maps MANAGER/STAFF to AGENT, Na Pista keeps the org role, unknown apps have none", () => {
  assert.deepEqual(resolveEffectiveApplicationRole({ applicationKey: "QUALE_A_DICA", organizationRoleKey: "MANAGER" }), { roleKey: "AGENT", source: "fallback" });
  assert.deepEqual(resolveEffectiveApplicationRole({ applicationKey: "QUALE_A_DICA", organizationRoleKey: "STAFF" }), { roleKey: "AGENT", source: "fallback" });
  assert.deepEqual(resolveEffectiveApplicationRole({ applicationKey: "QUALE_A_DICA", organizationRoleKey: "OWNER" }), { roleKey: "OWNER", source: "fallback" });
  assert.deepEqual(resolveEffectiveApplicationRole({ applicationKey: "NA_PISTA", organizationRoleKey: "MANAGER" }), { roleKey: "MANAGER", source: "fallback" });
  assert.deepEqual(resolveEffectiveApplicationRole({ applicationKey: "QUALE_A_DICA", organizationRoleKey: "ADMIN", explicitRoleKey: "AGENT" }), { roleKey: "AGENT", source: "explicit" });
  assert.equal(resolveEffectiveApplicationRole({ applicationKey: "FOI", organizationRoleKey: "OWNER" }), null);
});

test("/v1/me: identity contract — status, emailVerified from auth.users, organization status, existing fields preserved", async () => {
  const u = await user("p6-me");
  const o = await org("p6-me-org", u.id);
  await addMember(u.id, o.id, "OWNER");
  const token = await tokenFor(u);

  let me = await call("GET", "/me", token);
  assert.equal(me.status, 200);
  assert.equal(meOf(me).userId, u.id);
  assert.equal(meOf(me).status, "active");
  assert.equal(meOf(me).emailVerified, false, "no confirmed email → false (fail closed)");
  const m = membershipIn(me, o.id);
  assert.equal(m.roleKey, "OWNER");
  assert.equal(m.status, "active");
  assert.equal(m.organizationName, o.name, "pre-Fase-6 field kept for Na Pista");
  assert.deepEqual(m.organization, { id: o.id, name: o.name, slug: o.slug, status: "active" });
  assert.deepEqual(m.applications, []);

  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${u.id}, now())`);
  me = await call("GET", "/me", token);
  assert.equal(meOf(me).emailVerified, true);
});

test("invalid and expired tokens are refused (401)", async () => {
  const u = await user("p6-tokens");
  assert.equal((await call("GET", "/me", "not.a.jwt")).status, 401);
  const expired = await new SignJWT({ email: u.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(secret);
  assert.equal((await call("GET", "/me", expired)).status, 401);
  assert.equal((await call("GET", "/me")).status, 401);
});

test("disabled user: refused with ACCOUNT_DISABLED even with a valid session; reactivation restores access", async () => {
  const u = await user("p6-disabled");
  const token = await tokenFor(u);
  const adminToken = await tokenFor(platformAdmin);
  assert.equal((await call("GET", "/me", token)).status, 200);

  const off = await call("PATCH", `/platform/users/${u.id}/status`, adminToken, { status: "disabled" });
  assert.equal(off.status, 200);
  assert.equal((off.data as { status: string }).status, "disabled");
  const refused = await call("GET", "/me", token);
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "ACCOUNT_DISABLED");

  assert.equal((await call("PATCH", `/platform/users/${u.id}/status`, adminToken, { status: "active" })).status, 200);
  assert.equal((await call("GET", "/me", token)).status, 200);
});

test("suspended organization: members get ORGANIZATION_SUSPENDED, its service keys stop working, other orgs unaffected; reactivation restores", async () => {
  const owner = await user("p6-susp-owner");
  const o = await org("p6-susp", owner.id);
  const other = await org("p6-susp-other", owner.id);
  await addMember(owner.id, o.id, "OWNER");
  await addMember(owner.id, other.id, "OWNER");
  const token = await tokenFor(owner);
  const adminToken = await tokenFor(platformAdmin);
  const key = await createOrganizationApiKey({ organizationId: o.id, applicationKey: "NA_PISTA", actorUserId: owner.id, scopes: ["usage.read"] });

  assert.equal((await call("GET", `/organizations/${o.id}`, token)).status, 200);
  assert.equal((await call("GET", "/service/me", key.secret)).status, 200);

  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "suspended" })).status, 200);
  const member = await call("GET", `/organizations/${o.id}`, token);
  assert.equal(member.status, 403);
  assert.equal(member.code, "ORGANIZATION_SUSPENDED");
  const service = await call("GET", "/service/me", key.secret);
  assert.equal(service.status, 403);
  assert.equal(service.code, "ORGANIZATION_SUSPENDED");
  assert.equal((await call("GET", `/organizations/${other.id}`, token)).status, 200, "another organization keeps working");
  const me = await call("GET", "/me", token);
  assert.equal(membershipIn(me, o.id).organization.status, "suspended");

  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "active" })).status, 200);
  assert.equal((await call("GET", `/organizations/${o.id}`, token)).status, 200);
  assert.equal((await call("GET", "/service/me", key.secret)).status, 200);
});

test("cross-organization isolation and membership states: no membership / suspended membership → 403", async () => {
  const a = await user("p6-iso-a");
  const b = await user("p6-iso-b");
  const orgA = await org("p6-iso-a", a.id);
  const orgB = await org("p6-iso-b", b.id);
  await addMember(a.id, orgA.id, "OWNER");
  await addMember(b.id, orgB.id, "OWNER");
  const tokenA = await tokenFor(a);

  assert.equal((await call("GET", `/organizations/${orgA.id}`, tokenA)).status, 200);
  assert.equal((await call("GET", `/organizations/${orgB.id}`, tokenA)).status, 403, "user A cannot read org B");
  assert.equal((await call("GET", `/organizations/${orgB.id}/memberships`, tokenA)).status, 403);
  assert.equal((await call("GET", `/organizations/${orgB.id}/application-access`, tokenA)).status, 403);
  assert.equal((await call("GET", `/organizations/${randomUUID()}`, tokenA)).status, 403, "unknown organization");

  const c = await user("p6-iso-c");
  await addMember(c.id, orgB.id, "ADMIN", "suspended");
  assert.equal((await call("GET", `/organizations/${orgB.id}`, await tokenFor(c))).status, 403, "suspended (revoked) membership");
});

test("application access is separate from billing: a subscription grants nothing; explicit access lists the app with the effective role", async () => {
  const owner = await user("p6-access-owner");
  const manager = await user("p6-access-manager");
  const o = await org("p6-access", owner.id);
  await addMember(owner.id, o.id, "OWNER");
  const mgr = await addMember(manager.id, o.id, "MANAGER");
  const adminToken = await tokenFor(platformAdmin);
  const ownerToken = await tokenFor(owner);
  const managerToken = await tokenFor(manager);

  await createSubscription({ organizationId: o.id, applicationKey: "NA_PISTA", planKey: "BUSINESS", actorUserId: owner.id });
  let me = await call("GET", "/me", ownerToken);
  assert.deepEqual(membershipIn(me, o.id).applications, [], "subscription ≠ access");

  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200);
  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200, "idempotent");
  me = await call("GET", "/me", managerToken);
  assert.deepEqual(membershipIn(me, o.id).applications, [
    { key: "QUALE_A_DICA", roleKey: "AGENT", roleSource: "fallback" },
  ]);

  // explicit application role (an ADMIN-capable owner assigns AGENT → ADMIN inside QD only)
  const set = await call("PUT", `/organizations/${o.id}/memberships/${mgr.id}/applications/QUALE_A_DICA/role`, ownerToken, { roleKey: "ADMIN" });
  assert.equal(set.status, 200);
  me = await call("GET", "/me", managerToken);
  assert.deepEqual(membershipIn(me, o.id).applications, [
    { key: "QUALE_A_DICA", roleKey: "ADMIN", roleSource: "explicit" },
  ]);
  assert.equal(membershipIn(me, o.id).roleKey, "MANAGER", "organization role untouched");

  const access = await call("GET", `/organizations/${o.id}/application-access`, ownerToken);
  assert.equal(access.status, 200);
  assert.deepEqual(rows<{ applicationKey: string; status: string }>(access).map((r) => [r.applicationKey, r.status]), [["QUALE_A_DICA", "active"]]);

  assert.equal((await call("DELETE", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200);
  me = await call("GET", "/me", managerToken);
  assert.deepEqual(membershipIn(me, o.id).applications, [], "revoked access disappears");
  assert.equal((await call("DELETE", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 404, "nothing left to revoke");
});

test("application roles: validated against each application's catalog, OWNER only by OWNER, tenant-safe", async () => {
  const owner = await user("p6-roles-owner");
  const admin = await user("p6-roles-admin");
  const staff = await user("p6-roles-staff");
  const o = await org("p6-roles", owner.id);
  const foreign = await org("p6-roles-foreign", owner.id);
  await addMember(owner.id, o.id, "OWNER");
  await addMember(admin.id, o.id, "ADMIN");
  const staffMembership = await addMember(staff.id, o.id, "STAFF");
  const foreignMembership = await addMember(staff.id, foreign.id, "STAFF");
  const ownerToken = await tokenFor(owner);
  const adminToken = await tokenFor(admin);
  const path = (membershipId: string, app: string) => `/organizations/${o.id}/memberships/${membershipId}/applications/${app}/role`;

  assert.equal((await call("PUT", path(staffMembership.id, "QUALE_A_DICA"), ownerToken, { roleKey: "MANAGER" })).status, 400, "MANAGER is not a QD role");
  assert.equal((await call("PUT", path(staffMembership.id, "NA_PISTA"), ownerToken, { roleKey: "AGENT" })).status, 400, "AGENT is not a Na Pista role");
  assert.equal((await call("PUT", path(staffMembership.id, "NOPE"), ownerToken, { roleKey: "OWNER" })).status, 404);
  assert.equal((await call("PUT", path(staffMembership.id, "QUALE_A_DICA"), adminToken, { roleKey: "OWNER" })).status, 403, "only an OWNER grants OWNER");
  assert.equal((await call("PUT", path(staffMembership.id, "QUALE_A_DICA"), adminToken, { roleKey: "AGENT" })).status, 200, "ADMIN has role.assign");
  assert.equal((await call("PUT", path(foreignMembership.id, "QUALE_A_DICA"), ownerToken, { roleKey: "AGENT" })).status, 404, "membership of another org");
  assert.equal((await call("PUT", path(staffMembership.id, "QUALE_A_DICA"), await tokenFor(staff), { roleKey: "ADMIN" })).status, 403, "STAFF lacks role.assign");

  assert.equal((await call("DELETE", path(staffMembership.id, "QUALE_A_DICA"), adminToken)).status, 200);
  assert.equal((await call("DELETE", path(staffMembership.id, "QUALE_A_DICA"), adminToken)).status, 404);

  const catalog = await call("GET", "/applications/QUALE_A_DICA/roles", ownerToken);
  assert.deepEqual(rows<{ key: string }>(catalog).map((r) => r.key), ["ADMIN", "AGENT", "OWNER"]);
});

test("platform operations require the platform permission (an organization OWNER is not enough)", async () => {
  const owner = await user("p6-platform-guard");
  const o = await org("p6-platform-guard", owner.id);
  await addMember(owner.id, o.id, "OWNER");
  const token = await tokenFor(owner);
  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, token, { status: "suspended" })).status, 403);
  assert.equal((await call("PATCH", `/platform/users/${owner.id}/status`, token, { status: "disabled" })).status, 403);
  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, token)).status, 403);
  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, await tokenFor(platformAdmin), { status: "frozen" })).status, 400);
});

test("fallback covers every organization role for both applications (QD: OWNER/ADMIN/AGENT; Na Pista keeps its own roles)", () => {
  const qd = ["OWNER", "ADMIN", "MANAGER", "STAFF"].map((r) => resolveEffectiveApplicationRole({ applicationKey: "QUALE_A_DICA", organizationRoleKey: r })?.roleKey);
  const np = ["OWNER", "ADMIN", "MANAGER", "STAFF"].map((r) => resolveEffectiveApplicationRole({ applicationKey: "NA_PISTA", organizationRoleKey: r })?.roleKey);
  assert.deepEqual(qd, ["OWNER", "ADMIN", "AGENT", "AGENT"]);
  assert.deepEqual(np, ["OWNER", "ADMIN", "MANAGER", "STAFF"]);
});

test("effective access needs an active membership in an active organization; grants are refused for suspended orgs and unknown apps", async () => {
  const owner = await user("p6-eff-owner");
  const agent = await user("p6-eff-agent");
  const o = await org("p6-eff", owner.id);
  await addMember(owner.id, o.id, "OWNER");
  const agentMembership = await addMember(agent.id, o.id, "STAFF");
  const adminToken = await tokenFor(platformAdmin);
  const agentToken = await tokenFor(agent);

  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200);
  assert.deepEqual(membershipIn(await call("GET", "/me", agentToken), o.id).applications, [{ key: "QUALE_A_DICA", roleKey: "AGENT", roleSource: "fallback" }]);

  await db.update(memberships).set({ status: "suspended" }).where(eq(memberships.id, agentMembership.id));
  let m = membershipIn(await call("GET", "/me", agentToken), o.id);
  assert.equal(m.status, "suspended");
  assert.deepEqual(m.applications, [], "suspended membership → no effective access");
  await db.update(memberships).set({ status: "active" }).where(eq(memberships.id, agentMembership.id));

  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "suspended" })).status, 200);
  m = membershipIn(await call("GET", "/me", agentToken), o.id);
  assert.deepEqual(m.applications, [], "suspended organization → no effective access");
  const refused = await call("PUT", `/platform/organizations/${o.id}/applications/NA_PISTA/access`, adminToken);
  assert.equal(refused.status, 409, "no new access for a suspended organization");
  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "active" })).status, 200);
  assert.equal(membershipIn(await call("GET", "/me", agentToken), o.id).applications.length, 1, "reactivation restores access");

  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/NOPE/access`, adminToken)).status, 404);
  assert.equal((await call("PUT", `/platform/organizations/${randomUUID()}/applications/QUALE_A_DICA/access`, adminToken)).status, 404);
});

test("one application role per (membership, application) and a complete audit trail", async () => {
  const owner = await user("p6-audit-owner");
  const member = await user("p6-audit-member");
  const o = await org("p6-audit", owner.id);
  const ownerMembership = await addMember(owner.id, o.id, "OWNER");
  const mm = await addMember(member.id, o.id, "MANAGER");
  const ownerToken = await tokenFor(owner);
  const adminToken = await tokenFor(platformAdmin);
  const rolePath = `/organizations/${o.id}/memberships/${mm.id}/applications/QUALE_A_DICA/role`;

  assert.equal((await call("PUT", rolePath, ownerToken, { roleKey: "AGENT" })).status, 200);
  assert.equal((await call("PUT", rolePath, ownerToken, { roleKey: "ADMIN" })).status, 200);
  const rowsForMembership = await db.select().from(membershipApplicationRoles).where(eq(membershipApplicationRoles.membershipId, mm.id));
  assert.equal(rowsForMembership.length, 1, "replaced, never duplicated");
  assert.equal(rowsForMembership[0]!.roleKey, "ADMIN");
  await assert.rejects(
    () => db.insert(membershipApplicationRoles).values({ membershipId: mm.id, applicationId: rowsForMembership[0]!.applicationId, roleKey: "AGENT" }),
    "the unique index refuses a second row",
  );
  await assert.rejects(
    () => db.insert(membershipApplicationRoles).values({ membershipId: ownerMembership.id, applicationId: rowsForMembership[0]!.applicationId, roleKey: "MANAGER" }),
    "the composite FK refuses a role outside the application's catalog",
  );

  assert.equal((await call("PUT", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200);
  assert.equal((await call("DELETE", `/platform/organizations/${o.id}/applications/QUALE_A_DICA/access`, adminToken)).status, 200);
  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "suspended" })).status, 200);
  assert.equal((await call("PATCH", `/platform/organizations/${o.id}/status`, adminToken, { status: "active" })).status, 200);
  assert.equal((await call("DELETE", rolePath, ownerToken)).status, 200);

  const actions = (await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.organizationId, o.id))).map((a) => a.action);
  for (const expected of [
    "membership.application_role.set",
    "membership.application_role.removed",
    "organization.application_access.granted",
    "organization.application_access.revoked",
    "organization.suspended",
    "organization.reactivated",
  ]) {
    assert.ok(actions.includes(expected), `audit has ${expected}`);
  }
});

test("new Fase 6 tables are closed to the Supabase Data API (RLS on)", async () => {
  const rows = (await db.execute(sql`select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relname in ('application_roles', 'membership_application_roles', 'organization_application_access')
    order by relname`)) as unknown as Array<{ relname: string; relrowsecurity: boolean }>;
  assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity]), [
    ["application_roles", true],
    ["membership_application_roles", true],
    ["organization_application_access", true],
  ]);
});
