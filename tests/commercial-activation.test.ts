import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  applications,
  auditLogs,
  commercialEvents,
  contracts,
  contractVersions,
  entitlementGrants,
  memberships,
  organizationApplicationAccess,
  plans,
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  planEntitlements,
  roles,
  subscriptions,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey } from "../src/modules/apiKeys/service.js";
import { canonicalSha256 } from "../src/modules/commercial/canonicalJson.js";
import { getEffectiveEntitlements } from "../src/modules/entitlements/service.js";
import { isGrantEffective, isSubscriptionEffective } from "../src/modules/entitlements/effectiveness.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * Block 1D — contract → entitlement → activation, end to end over HTTP on the
 * disposable test database (guarded). Local JWTs (TEST secret), a minimal
 * `auth.users`; no network beyond the local server, no real credentials.
 * Every catalog change made here (application/plan status, a temporary test
 * trigger) is restored in `finally`; commercial history stays (immutable by
 * design); test platform memberships are removed in `after`.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();

type User = { id: string; email: string };
type Json = ReturnType<typeof JSON.parse>;
type Res = { status: number; data: Json; code?: string; raw: string };

async function tokenFor(user: User) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
}

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : null;
  return { status: res.status, data: json?.data, code: json?.error?.code, raw };
}

const createdAuthUsers: string[] = [];
const platformUsers: string[] = [];
let readOnlyRoleId: string | undefined;

async function person(prefix: string) {
  const user = await createTestUser(`b1d-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, now())`);
  return { user, token: await tokenFor(user) };
}

async function platformPerson(roleKey: string) {
  const p = await person(`platform-${roleKey.toLowerCase()}`);
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, roleKey));
  await db.insert(platformMemberships).values({ userId: p.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  platformUsers.push(p.user.id);
  return p;
}

let admin: { user: User; token: string };
let readOnly: { user: User; token: string };
let termsId: string;

const NA = { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "20000000", billingPeriod: "monthly", durationMonths: 1 };
const QD = { kind: "application_plan", title: "Qualé a Dica Business", applicationKey: "QUALE_A_DICA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "15000000", billingPeriod: "monthly", durationMonths: 3 };
const SERVICE = { kind: "service", title: "Configuração inicial", quantity: 1, unitPriceMinor: "5000000" };

/** Full commercial chain through the real API: proposal (one option with `items`) → send → acceptance by the OWNER → pending contract. */
async function pendingContract(items: Array<Record<string, unknown>>) {
  const owner = await person("owner");
  const org = await createTestOrganization("b1d-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const created = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "Cliente", recipientName: "Dest", recipientEmail: owner.user.email, organizationId: org.id, validUntil: future(), termsTemplateId: termsId });
  assert.equal(created.status, 201, created.raw);
  const proposalId = created.data.id as string;
  const versionId = created.data.versions[0].id as string;
  const v = `/platform/proposals/${proposalId}/versions/${versionId}`;
  const opt = await call("POST", `${v}/options`, admin.token, { name: "Opção", isRecommended: true });
  const optionId = opt.data.options[0].id as string;
  for (const [i, item] of items.entries()) {
    const r = await call("POST", `${v}/options/${optionId}/items`, admin.token, { ...item, sort: i });
    assert.equal(r.status, 201, r.raw);
  }
  const sent = await call("POST", `${v}/send`, admin.token);
  assert.equal(sent.status, 200, sent.raw);
  const acc = await call("POST", `/proposals/${proposalId}/acceptance`, owner.token, { versionId, optionId, contentSha256: sent.data.contentSha256, signerName: "Signatário", consent: true }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(acc.status, 201, acc.raw);
  return { contractId: acc.data.contract.id as string, orgId: org.id, owner };
}

const activate = (contractId: string, token = admin.token, body?: unknown) => call("POST", `/platform/contracts/${contractId}/activation`, token, body);

async function counts(orgId: string) {
  const [g] = await db.select({ n: sql<number>`count(*)::int` }).from(entitlementGrants).where(eq(entitlementGrants.organizationId, orgId));
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(subscriptions).where(eq(subscriptions.organizationId, orgId));
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(organizationApplicationAccess).where(and(eq(organizationApplicationAccess.organizationId, orgId), eq(organizationApplicationAccess.status, "active")));
  return { grants: g!.n, subscriptions: s!.n, access: a!.n };
}

async function eventTypes(aggregateIds: string[]) {
  if (!aggregateIds.length) return [];
  return (await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(inArray(commercialEvents.aggregateId, aggregateIds))).map((e) => e.t).sort();
}

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  admin = await platformPerson("PLATFORM_ADMIN");
  const [role] = await db.insert(platformRoles).values({ key: `TEST_B1D_READ_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test read-only" }).returning();
  readOnlyRoleId = role!.id;
  const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, "platform.commercial.read"));
  await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  readOnly = await platformPerson(role!.key);
  const body = `Termos de TESTE ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`b1d-${randomUUID().slice(0, 8)}`}, 1, 'Termos', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
});

after(async () => {
  server.close();
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  if (readOnlyRoleId) {
    await db.delete(platformRolePermissions).where(eq(platformRolePermissions.platformRoleId, readOnlyRoleId));
    await db.delete(platformRoles).where(eq(platformRoles.id, readOnlyRoleId));
  }
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

test("effectiveness helpers: canceled or past-period subscriptions and non-active or ended grants grant nothing", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  assert.equal(isSubscriptionEffective({ status: "active", currentPeriodEnd: null }, now), true);
  assert.equal(isSubscriptionEffective({ status: "active", currentPeriodEnd: new Date("2026-10-07T00:00:00Z") }, now), true);
  assert.equal(isSubscriptionEffective({ status: "active", currentPeriodEnd: new Date("2026-10-06T11:59:59Z") }, now), false);
  assert.equal(isSubscriptionEffective({ status: "canceled", currentPeriodEnd: null }, now), false);
  assert.equal(isGrantEffective({ status: "active", endsAt: null }, now), true);
  assert.equal(isGrantEffective({ status: "active", endsAt: new Date("2026-10-06T11:00:00Z") }, now), false);
  assert.equal(isGrantEffective({ status: "planned", endsAt: null }, now), false);
});

test("preview is read-only and shows what activation would create; valid activation creates grants, subscriptions and access atomically", async () => {
  const { contractId, orgId, owner } = await pendingContract([NA, QD, SERVICE]);
  const [cBefore] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  const [cvBefore] = await db.select().from(contractVersions).where(eq(contractVersions.id, cBefore!.currentVersionId!));

  const preview = await call("GET", `/platform/contracts/${contractId}/activation-preview`, admin.token);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.activatable, true);
  assert.deepEqual(preview.data.blockers, []);
  assert.deepEqual(preview.data.items.map((i: { eligible: boolean }) => i.eligible), [true, true, false]);
  assert.deepEqual(await counts(orgId), { grants: 0, subscriptions: 0, access: 0 }, "preview creates nothing");
  assert.deepEqual(await eventTypes([contractId]), ["contract.created"]);

  const res = await activate(contractId);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.status, "active");
  assert.ok(res.data.startsAt);
  const grants = res.data.grants as Array<{ id: string; status: string; subscriptionId: string; applicationAccessId: string; startsAt: string; endsAt: string }>;
  assert.equal(grants.length, 2, "only application_plan items produce grants");
  for (const g of grants) {
    assert.equal(g.status, "active");
    assert.ok(g.subscriptionId && g.applicationAccessId);
  }
  assert.equal(new Date(res.data.endsAt).getTime(), Math.max(...grants.map((g) => new Date(g.endsAt).getTime())), "contract ends with its longest grant (3 months)");
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
  assert.equal(subs.length, 2);
  for (const s of subs) assert.ok(s.currentPeriodEnd, "a contractual subscription always has an explicit end");
  assert.deepEqual(await counts(orgId), { grants: 2, subscriptions: 2, access: 2 });

  const me = await call("GET", "/me", owner.token);
  const apps = (me.data.memberships.find((m: { organizationId: string }) => m.organizationId === orgId).applications as Array<{ key: string }>).map((a) => a.key).sort();
  assert.deepEqual(apps, ["NA_PISTA", "QUALE_A_DICA"]);
  const ent = await getEffectiveEntitlements(orgId, "NA_PISTA");
  assert.equal(ent.subscription?.status, "active");

  assert.deepEqual(await eventTypes([contractId]), ["contract.activated", "contract.created"]);
  assert.deepEqual(await eventTypes(grants.map((g) => g.id)), ["entitlement.activated", "entitlement.activated", "entitlement.planned", "entitlement.planned"]);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, contractId), eq(auditLogs.action, "platform.commercial.contract.activated")))).length, 1);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "subscription.created")))).length, 2);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "organization.application_access.granted")))).length, 2);

  const [cvAfter] = await db.select().from(contractVersions).where(eq(contractVersions.id, cBefore!.currentVersionId!));
  assert.equal(cvAfter!.contentSha256, cvBefore!.contentSha256);
  assert.equal(canonicalSha256(cvAfter!.snapshot), cvAfter!.contentSha256, "the contract photograph is untouched by activation");

  const again = await activate(contractId);
  assert.equal(again.status, 200, "activating an active contract is idempotent");
  assert.deepEqual(await counts(orgId), { grants: 2, subscriptions: 2, access: 2 });
  assert.equal((await eventTypes([contractId])).filter((t) => t === "contract.activated").length, 1);
});

test("authorization: read-only platform role 403, client OWNER 403, service credential 403, unknown contract 404", async () => {
  const { contractId, owner } = await pendingContract([SERVICE]);
  assert.equal((await activate(contractId, readOnly.token)).status, 403);
  assert.equal((await call("GET", `/platform/contracts/${contractId}/activation-preview`, readOnly.token)).status, 200, "preview is a read");
  assert.equal((await activate(contractId, owner.token)).status, 403, "the client never activates");
  const keyOrg = await createTestOrganization("b1d-keyorg", owner.user.id);
  await grantTestApplicationAccess(keyOrg.id, "NA_PISTA");
  const key = await createOrganizationApiKey({ organizationId: keyOrg.id, applicationKey: "NA_PISTA", actorUserId: owner.user.id, scopes: ["usage.read"] });
  assert.equal((await activate(contractId, key.secret)).status, 403, "service credentials never reach the platform plane");
  assert.equal((await activate(randomUUID())).status, 404);
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "pending_activation");
});

test("tenant: the organization always comes from the contract; a request organizationId is ignored", async () => {
  const { contractId, orgId } = await pendingContract([NA]);
  const other = await person("other");
  const otherOrg = await createTestOrganization("b1d-other", other.user.id);
  const res = await activate(contractId, admin.token, { organizationId: otherOrg.id });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.organizationId, orgId);
  assert.deepEqual(await counts(otherOrg.id), { grants: 0, subscriptions: 0, access: 0 });
  assert.deepEqual(await counts(orgId), { grants: 1, subscriptions: 1, access: 1 });
});

test("blockers (409, nothing created): duplicate application, inactive application/plan, missing duration, unsupported entitlementSpec", async () => {
  const dup = await pendingContract([NA, { ...NA, title: "Outra vez Na Pista" }]);
  const r1 = await activate(dup.contractId);
  assert.equal(r1.status, 409);
  assert.equal(r1.code, "DUPLICATE_APPLICATION");
  assert.deepEqual(await counts(dup.orgId), { grants: 0, subscriptions: 0, access: 0 });

  const noDuration = await pendingContract([{ ...NA, durationMonths: null }]);
  const r2 = await activate(noDuration.contractId);
  assert.equal(r2.code, "DURATION_REQUIRED");
  const prev = await call("GET", `/platform/contracts/${noDuration.contractId}/activation-preview`, admin.token);
  assert.equal(prev.data.activatable, false);
  assert.equal(prev.data.blockers[0].code, "DURATION_REQUIRED");

  const badSpec = await pendingContract([{ ...NA, entitlementSpec: { seats: 3 } }]);
  assert.equal((await activate(badSpec.contractId)).code, "ENTITLEMENT_SPEC_UNSUPPORTED");
  const [planRow] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "NA_PISTA"), eq(plans.key, "BUSINESS")));
  const [entitlement] = await db.select().from(planEntitlements).where(eq(planEntitlements.planId, planRow!.id)).limit(1);
  const goodSpec = await pendingContract([{ ...NA, entitlementSpec: { [entitlement!.key]: entitlement!.value } }]);
  assert.equal((await activate(goodSpec.contractId)).status, 201, "a spec exactly provided by the plan is honoured");

  const inactiveApp = await pendingContract([QD]);
  await db.update(applications).set({ status: "SUSPENDED" }).where(eq(applications.key, "QUALE_A_DICA"));
  try {
    assert.equal((await activate(inactiveApp.contractId)).code, "APPLICATION_INACTIVE");
  } finally {
    await db.update(applications).set({ status: "ACTIVE" }).where(eq(applications.key, "QUALE_A_DICA"));
  }
  const inactivePlan = await pendingContract([QD]);
  const [qdPlan] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "QUALE_A_DICA"), eq(plans.key, "BUSINESS")));
  await db.update(plans).set({ status: "ARCHIVED" }).where(eq(plans.id, qdPlan!.id));
  try {
    assert.equal((await activate(inactivePlan.contractId)).code, "PLAN_INACTIVE");
  } finally {
    await db.update(plans).set({ status: "ACTIVE" }).where(eq(plans.id, qdPlan!.id));
  }
  for (const c of [noDuration, badSpec, inactiveApp, inactivePlan]) assert.deepEqual(await counts(c.orgId), { grants: 0, subscriptions: 0, access: 0 });
});

test("conflicts are refused, never adopted: existing subscription, existing manual access (untouched)", async () => {
  const subConflict = await pendingContract([NA]);
  await createSubscription({ organizationId: subConflict.orgId, applicationKey: "NA_PISTA", planKey: "STARTER", actorUserId: admin.user.id });
  const r1 = await activate(subConflict.contractId);
  assert.equal(r1.status, 409);
  assert.equal(r1.code, "SUBSCRIPTION_CONFLICT");

  const accessConflict = await pendingContract([NA]);
  await grantTestApplicationAccess(accessConflict.orgId, "NA_PISTA");
  const [before] = await db.select().from(organizationApplicationAccess).where(eq(organizationApplicationAccess.organizationId, accessConflict.orgId));
  const r2 = await activate(accessConflict.contractId);
  assert.equal(r2.status, 409);
  assert.equal(r2.code, "APPLICATION_ACCESS_CONFLICT");
  const [afterRow] = await db.select().from(organizationApplicationAccess).where(eq(organizationApplicationAccess.organizationId, accessConflict.orgId));
  assert.deepEqual(afterRow, before, "the manual access is neither overwritten, linked nor revoked");
  assert.equal((await db.select().from(entitlementGrants).where(eq(entitlementGrants.organizationId, accessConflict.orgId))).length, 0);
});

test("contract with service items only activates with zero grants, subscriptions and access", async () => {
  const { contractId, orgId } = await pendingContract([SERVICE, { kind: "support", title: "Suporte", unitPriceMinor: "100" }]);
  const res = await activate(contractId);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.status, "active");
  assert.equal(res.data.grants.length, 0);
  assert.equal(res.data.endsAt, null);
  assert.deepEqual(await counts(orgId), { grants: 0, subscriptions: 0, access: 0 });
});

test("all-or-nothing: a blocker on one item, or a failure in the middle of the transaction, leaves nothing behind", async () => {
  const blocked = await pendingContract([NA, QD]);
  await grantTestApplicationAccess(blocked.orgId, "QUALE_A_DICA");
  assert.equal((await activate(blocked.contractId)).code, "APPLICATION_ACCESS_CONFLICT");
  const c1 = await counts(blocked.orgId);
  assert.deepEqual({ grants: c1.grants, subscriptions: c1.subscriptions }, { grants: 0, subscriptions: 0 }, "no partial activation of NA_PISTA");

  const midway = await pendingContract([NA, QD]);
  const [qdPlan] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "QUALE_A_DICA"), eq(plans.key, "BUSINESS")));
  // Test-only trigger in the DISPOSABLE database: the 2nd subscription insert fails after the 1st grant/subscription/access exist.
  await db.execute(sql.raw(`create or replace function b1d_fail_qd() returns trigger language plpgsql as $$ begin if new.plan_id = '${qdPlan!.id}' then raise exception 'b1d forced failure'; end if; return new; end $$`));
  await db.execute(sql.raw(`create trigger b1d_fail_qd before insert on subscriptions for each row execute function b1d_fail_qd()`));
  try {
    const res = await activate(midway.contractId);
    assert.equal(res.status, 500);
  } finally {
    await db.execute(sql.raw("drop trigger if exists b1d_fail_qd on subscriptions"));
    await db.execute(sql.raw("drop function if exists b1d_fail_qd()"));
  }
  assert.deepEqual(await counts(midway.orgId), { grants: 0, subscriptions: 0, access: 0 });
  const [c] = await db.select().from(contracts).where(eq(contracts.id, midway.contractId));
  assert.equal(c!.status, "pending_activation");
  assert.deepEqual(await eventTypes([midway.contractId]), ["contract.created"]);
  assert.equal((await activate(midway.contractId)).status, 201, "after the failure the contract can still be activated");
});

test("concurrency: simultaneous activations produce exactly one set of effects", async () => {
  const { contractId, orgId } = await pendingContract([NA, QD]);
  const results = await Promise.all([activate(contractId), activate(contractId), activate(contractId)]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.every((r) => r.status === 201 || r.status === 200));
  assert.deepEqual(await counts(orgId), { grants: 2, subscriptions: 2, access: 2 });
});

test("revocation: grant revoked, its subscription canceled and access revoked; contract unchanged; idempotent; audited", async () => {
  const { contractId, orgId, owner } = await pendingContract([NA, QD]);
  const act = await activate(contractId);
  const naGrant = (act.data.grants as Array<{ id: string; subscriptionId: string; applicationAccessId: string }>)[0]!;
  const r1 = await call("POST", `/platform/entitlement-grants/${naGrant.id}/revocation`, admin.token, { reason: "teste" });
  assert.equal(r1.status, 200, r1.raw);
  assert.equal(r1.data.status, "revoked");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, naGrant.subscriptionId));
  assert.equal(sub!.status, "canceled");
  const [access] = await db.select().from(organizationApplicationAccess).where(eq(organizationApplicationAccess.id, naGrant.applicationAccessId));
  assert.equal(access!.status, "revoked");
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "active", "revoking a grant does not change the contract");
  const me = await call("GET", "/me", owner.token);
  const keys = (me.data.memberships.find((m: { organizationId: string }) => m.organizationId === orgId).applications as Array<{ key: string }>).map((a) => a.key);
  assert.equal(keys.includes("NA_PISTA"), false);
  const r2 = await call("POST", `/platform/entitlement-grants/${naGrant.id}/revocation`, admin.token, { reason: "de novo" });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.revokedAt, r1.data.revokedAt, "idempotent");
  assert.deepEqual((await eventTypes([naGrant.id])).filter((t) => t === "entitlement.revoked"), ["entitlement.revoked"]);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, naGrant.id), eq(auditLogs.action, "platform.commercial.entitlement.revoked")))).length, 1);
  assert.equal((await call("POST", `/platform/entitlement-grants/${naGrant.id}/revocation`, readOnly.token, { reason: "x" })).status, 403);
  assert.equal((await call("POST", `/platform/entitlement-grants/${naGrant.id}/revocation`, owner.token, { reason: "x" })).status, 403);
});

test("lifecycle: cancel a pending contract (then activation 409); terminate an active one (all grants revoked)", async () => {
  const pending = await pendingContract([NA]);
  const cancelled = await call("POST", `/platform/contracts/${pending.contractId}/cancellation`, admin.token);
  assert.equal(cancelled.status, 200, cancelled.raw);
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal((await call("POST", `/platform/contracts/${pending.contractId}/cancellation`, admin.token)).status, 200, "idempotent");
  const blocked = await activate(pending.contractId);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "CONTRACT_NOT_ACTIVATABLE");
  assert.deepEqual(await eventTypes([pending.contractId]), ["contract.cancelled", "contract.created"]);

  const live = await pendingContract([NA, QD]);
  await activate(live.contractId);
  assert.equal((await call("POST", `/platform/contracts/${live.contractId}/cancellation`, admin.token)).code, "CONTRACT_NOT_CANCELLABLE");
  const terminated = await call("POST", `/platform/contracts/${live.contractId}/termination`, admin.token);
  assert.equal(terminated.status, 200, terminated.raw);
  assert.equal(terminated.data.status, "terminated");
  assert.ok((terminated.data.grants as Array<{ status: string }>).every((g) => g.status === "revoked"));
  assert.deepEqual(await counts(live.orgId), { grants: 2, subscriptions: 2, access: 0 });
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, live.orgId));
  assert.ok(subs.every((s) => s.status === "canceled"));
  assert.equal((await activate(live.contractId)).code, "CONTRACT_NOT_ACTIVATABLE");
  assert.equal((await call("POST", `/platform/contracts/${live.contractId}/termination`, readOnly.token)).status, 403);
  assert.deepEqual((await eventTypes([live.contractId])).sort(), ["contract.activated", "contract.created", "contract.terminated"]);
});

test("a contractual subscription cannot be canceled through self-service (409 SUBSCRIPTION_CONTRACT_MANAGED)", async () => {
  const { contractId, orgId, owner } = await pendingContract([NA]);
  const act = await activate(contractId);
  const subId = (act.data.grants as Array<{ subscriptionId: string }>)[0]!.subscriptionId;
  const res = await call("PATCH", `/organizations/${orgId}/subscriptions/${subId}`, owner.token, { status: "canceled" });
  assert.equal(res.status, 409);
  assert.equal(res.code, "SUBSCRIPTION_CONTRACT_MANAGED");
  const stranger = await pendingContract([SERVICE]);
  const foreign = await call("PATCH", `/organizations/${stranger.orgId}/subscriptions/${subId}`, stranger.owner.token, { status: "canceled" });
  assert.equal(foreign.status, 404, "another tenant learns nothing about this subscription (no 409 oracle)");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
  assert.equal(sub!.status, "active");
});

test("runtime expiration: past the grant/subscription end nothing is granted, even before any housekeeping", async () => {
  const { contractId, orgId, owner } = await pendingContract([NA]);
  const act = await activate(contractId);
  const g = (act.data.grants as Array<{ id: string; subscriptionId: string }>)[0]!;
  assert.equal((await getEffectiveEntitlements(orgId, "NA_PISTA")).subscription?.status, "active");
  // Move the period into the past (stored statuses stay "active": no housekeeping has run).
  await db.update(entitlementGrants).set({ startsAt: sql`now() - interval '2 months'`, endsAt: sql`now() - interval '1 minute'` }).where(eq(entitlementGrants.id, g.id));
  await db.update(subscriptions).set({ currentPeriodStart: sql`now() - interval '2 months'`, currentPeriodEnd: sql`now() - interval '1 minute'` }).where(eq(subscriptions.id, g.subscriptionId));
  assert.equal((await getEffectiveEntitlements(orgId, "NA_PISTA")).subscription, null, "expired subscription grants no entitlements");
  const me = await call("GET", "/me", owner.token);
  const keys = (me.data.memberships.find((m: { organizationId: string }) => m.organizationId === orgId).applications as Array<{ key: string }>).map((a) => a.key);
  assert.equal(keys.includes("NA_PISTA"), false, "expired contractual access is not effective");
  const derived = await call("GET", `/organizations/${orgId}/applications`, owner.token);
  assert.equal(derived.raw.includes("NA_PISTA"), false);
  const key = await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "NA_PISTA" });
  assert.equal(key.status, 403);
  assert.equal(key.code, "APPLICATION_ACCESS_REQUIRED");
});

test("G6: an OWNER cannot mint an API key for an application without active access; with contractual access it can", async () => {
  const { contractId, orgId, owner } = await pendingContract([NA]);
  const denied = await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "NA_PISTA" });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "APPLICATION_ACCESS_REQUIRED");
  assert.equal((await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "FOI" })).status, 403);
  await activate(contractId);
  const allowed = await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "NA_PISTA" });
  assert.equal(allowed.status, 201, allowed.raw);
  assert.equal((await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "QUALE_A_DICA" })).status, 403, "only the contracted application");
});

test("tenant isolation: activating one organization's contract never touches another; clients never reach platform contract routes", async () => {
  const a = await pendingContract([NA]);
  const b = await pendingContract([NA]);
  await activate(a.contractId);
  assert.deepEqual(await counts(b.orgId), { grants: 0, subscriptions: 0, access: 0 });
  assert.equal((await call("GET", `/platform/contracts/${a.contractId}`, b.owner.token)).status, 403);
  assert.equal((await call("GET", `/organizations/${b.orgId}/contracts/${a.contractId}`, b.owner.token)).status, 404);
  const [cb] = await db.select().from(contracts).where(eq(contracts.id, b.contractId));
  assert.equal(cb!.status, "pending_activation");
  assert.equal((await activate(b.contractId)).status, 201, "A's grant/subscription/access never count as conflicts for B");
});
