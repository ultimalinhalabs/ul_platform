import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  applications,
  commercialEvents,
  entitlementDefinitions,
  entitlementGrants,
  grantEntitlementValues,
  memberships,
  organizationApplicationAccess,
  organizations,
  planEntitlementHistory,
  planEntitlements,
  plans,
  platformMemberships,
  platformRoles,
  roles,
  subscriptions,
} from "../src/db/schema/index.js";
import { ENTITLEMENT_DEFINITIONS, PLAN_ENTITLEMENTS } from "../src/db/seed/data.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { loadDefinitions, validatePlanEntitlements, valueMatchesType } from "../src/modules/entitlements/definitions.js";
import { getEffectiveEntitlements } from "../src/modules/entitlements/service.js";
import { resolveMemberLimit } from "../src/modules/memberships/memberLimit.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { backfill, sameEntitlementSet } from "../scripts/backfill-grant-entitlement-values.js";
import { classify, parseClassification } from "../scripts/classify-subscriptions.js";
import { confirmTestPayment, createTestOrganization, createTestUser } from "./helpers.js";

/**
 * Migration 0031 (audit 2026-10-20): typed entitlement definitions, values frozen on the contract, revocation /
 * expiry / suspension prevailing over contracted values, plan history, subscription origin. Disposable test
 * database (guarded); local JWTs; catalog values changed here are restored in `finally`.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();

type User = { id: string; email: string };
type Res = { status: number; data: ReturnType<typeof JSON.parse>; code?: string; raw: string };

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
let admin: { user: User; token: string };
let termsId: string;

async function person(prefix: string) {
  const user = await createTestUser(`ent31-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, now())`);
  return { user, token: await tokenFor(user) };
}

const NA_BUSINESS = { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "20000000", billingPeriod: "monthly", durationMonths: 1 };

/** proposal → send → OWNER acceptance → payment confirmed → activation, through the real API. */
async function activatedContract() {
  const owner = await person("owner");
  const org = await createTestOrganization("ent31-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const created = await call("POST", "/platform/proposals", admin.token, { prospectTaxId: "5000000000", prospectAddress: "Luanda, Rua de Teste 1", prospectCompanyName: "Cliente", recipientName: "Dest", recipientEmail: owner.user.email, organizationId: org.id, validUntil: future(), termsTemplateId: termsId });
  assert.equal(created.status, 201, created.raw);
  const v = `/platform/proposals/${created.data.id}/versions/${created.data.versions[0].id}`;
  const opt = await call("POST", `${v}/options`, admin.token, { name: "Opção", isRecommended: true });
  const optionId = opt.data.options[0].id as string;
  assert.equal((await call("POST", `${v}/options/${optionId}/items`, admin.token, { ...NA_BUSINESS, sort: 0 })).status, 201);
  const sent = await call("POST", `${v}/send`, admin.token);
  const acc = await call("POST", `/proposals/${created.data.id}/acceptance`, owner.token, { versionId: created.data.versions[0].id, optionId, contentSha256: sent.data.contentSha256, signerName: "Signatário", consent: true }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(acc.status, 201, acc.raw);
  const contractId = acc.data.contract.id as string;
  await confirmTestPayment(contractId, admin.user.id);
  const activated = await call("POST", `/platform/contracts/${contractId}/activation`, admin.token);
  assert.equal(activated.status, 201, activated.raw);
  const [grant] = await db.select().from(entitlementGrants).where(eq(entitlementGrants.contractId, contractId));
  return { orgId: org.id, owner, contractId, grant: grant! };
}

async function planId(applicationKey: string, planKey: string) {
  const [row] = await db.select({ id: plans.id }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, applicationKey), eq(plans.key, planKey)));
  return row!.id;
}

async function setPlanValue(pid: string, key: string, value: unknown) {
  await db.update(planEntitlements).set({ value }).where(and(eq(planEntitlements.planId, pid), eq(planEntitlements.key, key)));
}

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  admin = await person("admin");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: admin.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  platformUsers.push(admin.user.id);
  const body = `Termos de TESTE ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`ent31-${randomUUID().slice(0, 8)}`}, 1, 'Termos', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
});

after(async () => {
  server.close();
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

// ── Definitions ─────────────────────────────────────────────────────────────────────────────────────────

const NA_DEFS = ENTITLEMENT_DEFINITIONS.filter((d) => d.applicationKey === "NA_PISTA");

test("value types: a boolean is exactly true/false; a limit is a non-negative safe integer", () => {
  assert.equal(valueMatchesType("boolean", true), true);
  assert.equal(valueMatchesType("boolean", "true"), false);
  assert.equal(valueMatchesType("boolean", 1), false);
  assert.equal(valueMatchesType("limit", 500), true);
  assert.equal(valueMatchesType("limit", 0), true);
  for (const bad of [-1, 1.5, "500", null, Number.POSITIVE_INFINITY, true]) assert.equal(valueMatchesType("limit", bad), false, String(bad));
});

test("plan validation: unknown key, wrong type and unmet dependency are errors; deprecated is a warning; a false module needs nothing", () => {
  assert.deepEqual(validatePlanEntitlements([{ key: "catalog.enabled", value: true }], NA_DEFS).errors, []);
  assert.match(validatePlanEntitlements([{ key: "nope.enabled", value: true }], NA_DEFS).errors.join(), /no entitlement definition/);
  assert.match(validatePlanEntitlements([{ key: "catalog.enabled", value: "yes" }], NA_DEFS).errors.join(), /not a valid boolean/);
  assert.match(validatePlanEntitlements([{ key: "orders.enabled", value: true }], NA_DEFS).errors.join(), /requires catalog\.enabled/);
  assert.match(validatePlanEntitlements([{ key: "customers.enabled", value: false }, { key: "services.enabled", value: true }], NA_DEFS).errors.join(), /requires customers\.enabled/);
  assert.deepEqual(validatePlanEntitlements([{ key: "orders.enabled", value: false }], NA_DEFS).errors, []);
  assert.match(validatePlanEntitlements([{ key: "products.max", value: 10 }], NA_DEFS).errors.join(), /requires catalog\.enabled/);
  const deprecated = validatePlanEntitlements([{ key: "advanced_reports.enabled", value: true }], NA_DEFS);
  assert.deepEqual(deprecated.errors, []);
  assert.match(deprecated.warnings.join(), /deprecated/);
  // Storefront: checkout needs the store AND orders; the store needs the catalog — catalog.enabled alone unlocks neither.
  assert.match(validatePlanEntitlements([{ key: "catalog.enabled", value: true }, { key: "storefront.checkout.enabled", value: true }], NA_DEFS).errors.join(), /requires storefront\.enabled.*requires orders\.enabled/);
});

test("definitions are unique per application, not global (two applications may both define members.max); absent=unlimited only where declared", async () => {
  const rows = await db.select({ app: applications.key, key: entitlementDefinitions.key, absentPolicy: entitlementDefinitions.absentPolicy, valueType: entitlementDefinitions.valueType }).from(entitlementDefinitions).innerJoin(applications, eq(applications.id, entitlementDefinitions.applicationId));
  assert.deepEqual(rows.filter((r) => r.key === "members.max").map((r) => r.app).sort(), ["HOJE_TEM", "NA_PISTA"]);
  assert.deepEqual(rows.filter((r) => r.absentPolicy === "unlimited").map((r) => `${r.app}:${r.key}`).sort(), ["HOJE_TEM:members.max", "NA_PISTA:members.max"]);
  assert.equal(rows.find((r) => r.app === "NA_PISTA" && r.key === "products.max")!.absentPolicy, "deny");
  // A boolean can never declare "unlimited" (CHECK constraint).
  const [na] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, "NA_PISTA"));
  await assert.rejects(db.insert(entitlementDefinitions).values({ applicationId: na!.id, key: `t${randomUUID().slice(0, 6)}.enabled`, valueType: "boolean", absentPolicy: "unlimited", description: "x" }), (e: { cause?: { code?: string }; code?: string }) => (e.cause?.code ?? e.code) === "23514");
});

test("every seeded plan validates against the persisted definitions, and the per-module keys keep today's access (true wherever catalog.enabled was)", async () => {
  for (const appKey of new Set(PLAN_ENTITLEMENTS.map((p) => p.applicationKey))) {
    const defs = await loadDefinitions(db, appKey);
    for (const planKey of new Set(PLAN_ENTITLEMENTS.filter((p) => p.applicationKey === appKey).map((p) => p.planKey))) {
      const rows = await db.select({ key: planEntitlements.key, value: planEntitlements.value }).from(planEntitlements).where(eq(planEntitlements.planId, await planId(appKey, planKey)));
      assert.deepEqual(validatePlanEntitlements(rows, defs).errors, [], `${appKey}/${planKey}`);
      const values = new Map(rows.map((r) => [r.key, r.value]));
      if (values.get("catalog.enabled") === true) for (const k of ["orders.enabled", "customers.enabled", "services.enabled"]) assert.equal(values.get(k), true, `${planKey} ${k}`);
      assert.equal(values.has("storefront.enabled"), false, `${planKey}: storefront is in no plan`);
    }
  }
});

// ── Frozen contract values ──────────────────────────────────────────────────────────────────────────────

test("activation freezes the plan values on the grant and marks the subscription commercial; a later plan edit does not change the contract, only plan-based subscriptions", async () => {
  const pid = await planId("NA_PISTA", "BUSINESS");
  const { orgId, grant } = await activatedContract();
  const frozen = await db.select().from(grantEntitlementValues).where(eq(grantEntitlementValues.grantId, grant.id));
  const planRows = await db.select().from(planEntitlements).where(eq(planEntitlements.planId, pid));
  assert.deepEqual(Object.fromEntries(frozen.map((f) => [f.key, f.value])), Object.fromEntries(planRows.map((p) => [p.key, p.value])));
  assert.ok(frozen.every((f) => f.source === "plan"));
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, grant.subscriptionId!));
  assert.equal(sub!.origin, "commercial");

  const before = await getEffectiveEntitlements(orgId, "NA_PISTA");
  assert.deepEqual(before.access, { effective: true, reason: null });
  const products = before.entitlements.find((e) => e.key === "products.max")!;
  assert.deepEqual({ value: products.value, type: products.type, source: products.source, validUntil: products.validUntil }, { value: 1000, type: "limit", source: "contract", validUntil: grant.endsAt!.toISOString() });

  // A pre-commercial (no grant) subscription to the same plan, in another organization.
  const other = await createTestOrganization("ent31-precommercial");
  await createSubscription({ organizationId: other.id, applicationKey: "NA_PISTA", planKey: "BUSINESS", actorUserId: null });
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('ul.actor', 'test:ent31', true)`);
      await tx.update(planEntitlements).set({ value: 999 }).where(and(eq(planEntitlements.planId, pid), eq(planEntitlements.key, "products.max")));
    });
    const contract = await getEffectiveEntitlements(orgId, "NA_PISTA");
    assert.equal(contract.entitlements.find((e) => e.key === "products.max")!.value, 1000, "the accepted contract keeps its frozen value");
    const plan = await getEffectiveEntitlements(other.id, "NA_PISTA");
    const live = plan.entitlements.find((e) => e.key === "products.max")!;
    assert.deepEqual({ value: live.value, source: live.source, validUntil: live.validUntil }, { value: 999, source: "plan", validUntil: null });
    const [history] = await db.select().from(planEntitlementHistory).where(and(eq(planEntitlementHistory.planId, pid), eq(planEntitlementHistory.key, "products.max"), eq(planEntitlementHistory.actor, "test:ent31")));
    assert.deepEqual({ op: history!.operation, old: history!.oldValue, new: history!.newValue }, { op: "update", old: 1000, new: 999 });
  } finally {
    await setPlanValue(pid, "products.max", 1000);
  }
});

test("revocation, expiry, organization suspension and revoked application access prevail over contracted values (humans and services get the same empty answer)", async () => {
  const revoked = await activatedContract();
  await db.update(entitlementGrants).set({ status: "revoked", revokedAt: new Date(), revokedBy: admin.user.id, revokeReason: "test" }).where(eq(entitlementGrants.id, revoked.grant.id));
  const r = await getEffectiveEntitlements(revoked.orgId, "NA_PISTA");
  assert.deepEqual({ access: r.access, n: r.entitlements.length, sub: r.subscription !== null }, { access: { effective: false, reason: "GRANT_NOT_EFFECTIVE" }, n: 0, sub: true });

  const expired = await activatedContract();
  await db.update(entitlementGrants).set({ startsAt: new Date(Date.now() - 2 * 86_400_000), endsAt: new Date(Date.now() - 1000) }).where(eq(entitlementGrants.id, expired.grant.id));
  const e = await getEffectiveEntitlements(expired.orgId, "NA_PISTA");
  assert.deepEqual({ access: e.access, n: e.entitlements.length }, { access: { effective: false, reason: "GRANT_NOT_EFFECTIVE" }, n: 0 }, "the subscription period is still running, the grant is not");

  const suspended = await activatedContract();
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, suspended.orgId));
  const s = await getEffectiveEntitlements(suspended.orgId, "NA_PISTA");
  assert.deepEqual({ access: s.access, n: s.entitlements.length }, { access: { effective: false, reason: "ORGANIZATION_SUSPENDED" }, n: 0 });

  const noAccess = await activatedContract();
  await db.update(organizationApplicationAccess).set({ status: "revoked", revokedAt: new Date() }).where(eq(organizationApplicationAccess.organizationId, noAccess.orgId));
  const a = await getEffectiveEntitlements(noAccess.orgId, "NA_PISTA");
  assert.deepEqual({ access: a.access, n: a.entitlements.length }, { access: { effective: false, reason: "APPLICATION_ACCESS_REVOKED" }, n: 0 });

  // Over HTTP for a human with entitlement.read: same answer.
  const http = await call("GET", `/organizations/${noAccess.orgId}/applications/NA_PISTA/entitlements`, noAccess.owner.token);
  assert.equal(http.status, 200, http.raw);
  assert.deepEqual({ access: http.data.access, entitlements: http.data.entitlements }, { access: { effective: false, reason: "APPLICATION_ACCESS_REVOKED" }, entitlements: [] });

  const none = await getEffectiveEntitlements((await createTestOrganization("ent31-none")).id, "NA_PISTA");
  assert.deepEqual({ access: none.access, sub: none.subscription }, { access: { effective: false, reason: "NO_SUBSCRIPTION" }, sub: null });
});

test("the member limit reads the contract's frozen value, not the live plan", async () => {
  const pid = await planId("NA_PISTA", "BUSINESS");
  const { orgId, grant } = await activatedContract();
  assert.equal(await resolveMemberLimit(db, orgId), null, "BUSINESS has no members.max: no limit (declared absent policy)");
  await db.insert(planEntitlements).values({ planId: pid, key: "members.max", value: 3 });
  try {
    assert.equal(await resolveMemberLimit(db, orgId), null, "the contract froze no members.max — a plan edit adds no limit to it");
    assert.equal((await db.select().from(grantEntitlementValues).where(and(eq(grantEntitlementValues.grantId, grant.id), eq(grantEntitlementValues.key, "members.max")))).length, 0);
  } finally {
    await db.delete(planEntitlements).where(and(eq(planEntitlements.planId, pid), eq(planEntitlements.key, "members.max")));
  }
});

test("frozen values are insert-only, and only for a planned or active grant; plan history is append-only", async () => {
  const { grant } = await activatedContract();
  const [row] = await db.select().from(grantEntitlementValues).where(eq(grantEntitlementValues.grantId, grant.id)).limit(1);
  const code = (e: { cause?: { code?: string }; code?: string }) => e.cause?.code ?? e.code;
  await assert.rejects(db.update(grantEntitlementValues).set({ value: 1 }).where(eq(grantEntitlementValues.id, row!.id)), (e: never) => code(e) === "UL001");
  await assert.rejects(db.delete(grantEntitlementValues).where(eq(grantEntitlementValues.id, row!.id)), (e: never) => code(e) === "UL001");
  await db.update(entitlementGrants).set({ status: "revoked", revokedAt: new Date(), revokedBy: admin.user.id, revokeReason: "test" }).where(eq(entitlementGrants.id, grant.id));
  await assert.rejects(db.insert(grantEntitlementValues).values({ grantId: grant.id, key: "x.enabled", value: true }), (e: never) => code(e) === "23514");
  const [h] = await db.select().from(planEntitlementHistory).limit(1);
  await assert.rejects(db.update(planEntitlementHistory).set({ actor: "x" }).where(eq(planEntitlementHistory.id, h!.id)), (e: never) => code(e) === "UL001");
  await assert.rejects(db.delete(planEntitlementHistory).where(eq(planEntitlementHistory.id, h!.id)), (e: never) => code(e) === "UL001");
});

// ── Backfill and classification scripts ─────────────────────────────────────────────────────────────────

test("backfill freezes a pre-0031 grant exactly once (dry run writes nothing); the Growth guard compares the exact approved set", async () => {
  // Reproduce a grant activated before 0031: skip the activation's frozen-value insert for this test only.
  await db.execute(sql`create or replace function pg_temp_skip_freeze() returns trigger language plpgsql as $$ begin return null; end $$`);
  await db.execute(sql`create trigger zz_test_skip_freeze before insert on grant_entitlement_values for each row execute function pg_temp_skip_freeze()`);
  let legacy: Awaited<ReturnType<typeof activatedContract>>;
  try {
    legacy = await activatedContract();
  } finally {
    await db.execute(sql`drop trigger if exists zz_test_skip_freeze on grant_entitlement_values`);
    await db.execute(sql`drop function if exists pg_temp_skip_freeze()`);
  }
  assert.equal((await db.select().from(grantEntitlementValues).where(eq(grantEntitlementValues.grantId, legacy.grant.id))).length, 0);
  assert.equal((await getEffectiveEntitlements(legacy.orgId, "NA_PISTA")).entitlements.find((e) => e.key === "products.max")!.source, "plan", "unfrozen legacy grant follows the plan");

  const dry = await backfill({ apply: false, onlyGrantIds: [legacy.grant.id] });
  assert.equal(dry.length, 1);
  assert.equal((await db.select().from(grantEntitlementValues).where(eq(grantEntitlementValues.grantId, legacy.grant.id))).length, 0, "dry run writes nothing");

  const applied = await backfill({ apply: true, onlyGrantIds: [legacy.grant.id] });
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.values["products.max"], 1000);
  assert.equal((await getEffectiveEntitlements(legacy.orgId, "NA_PISTA")).entitlements.find((e) => e.key === "products.max")!.source, "contract");
  const events = await db.select().from(commercialEvents).where(and(eq(commercialEvents.aggregateId, legacy.grant.id), eq(commercialEvents.eventType, "entitlement.values_frozen")));
  assert.equal(events.length, 1);
  assert.deepEqual(await backfill({ apply: true, onlyGrantIds: [legacy.grant.id] }), [], "idempotent");

  const approved = { "catalog.enabled": true, "products.max": 500, "members.max": 5 };
  assert.equal(sameEntitlementSet(approved, { "members.max": 5, "catalog.enabled": true, "products.max": 500 }), true);
  assert.equal(sameEntitlementSet(approved, { ...approved, "products.max": 501 }), false);
  assert.equal(sameEntitlementSet(approved, { ...approved, "orders.enabled": true }), false);
});

test("classification sets a NULL origin once (audited) and refuses to change a classified subscription silently", async () => {
  assert.throws(() => parseClassification("not-a-uuid:test"), /expected/);
  assert.throws(() => parseClassification(`${randomUUID()}:prod`), /origin must be one of/);
  const id = randomUUID();
  assert.throws(() => parseClassification(`${id}:test,${id}:demo`), /twice/);

  const org = await createTestOrganization("ent31-classify");
  const sub = await createSubscription({ organizationId: org.id, applicationKey: "NA_PISTA", planKey: "STARTER", actorUserId: null });
  assert.equal(sub.origin, null);
  await classify([{ subscriptionId: sub.id, origin: "test" }], { apply: false });
  assert.equal((await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!.origin, null, "dry run");
  await classify([{ subscriptionId: sub.id, origin: "test" }], { apply: true });
  const [after1] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
  assert.deepEqual({ origin: after1!.origin, status: after1!.status, end: after1!.currentPeriodEnd }, { origin: "test", status: "active", end: null }, "classification changes nothing else");
  await assert.rejects(classify([{ subscriptionId: sub.id, origin: "demo" }], { apply: true }), /already classified/);
  await assert.rejects(db.update(subscriptions).set({ origin: "prod" as never }).where(eq(subscriptions.id, sub.id)));
});
