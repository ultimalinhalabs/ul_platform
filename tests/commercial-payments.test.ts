import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, count, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  auditLogs,
  commercialEvents,
  commercialPayments,
  contracts,
  entitlementGrants,
  memberships,
  organizationApplicationAccess,
  organizations,
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  roles,
  subscriptions,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey, createPlatformApiKey } from "../src/modules/apiKeys/service.js";
import { expireDueContracts } from "../src/modules/commercial/activation.service.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * Migration 0023 — payment confirmation, the third activation condition, over HTTP.
 * Assisted channel with manual confirmation by an authorized admin; integration confirmation by an
 * authenticated MICHA_EXPRESS platform credential; validation (amount, currency, reference, state),
 * duplicates, concurrency, DB guards, and the persisted expiry.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies vary per assertion
type Res = { status: number; data: any; code?: string; raw: string };
type User = Awaited<ReturnType<typeof createTestUser>>;

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setIssuer(EXPECTED_ISSUER).setExpirationTime("10m").sign(secret);
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
let admin: { user: User; token: string };
let readOnly: { user: User; token: string };
let termsId: string;
let michaToken: string;
let michaKeyId: string;

async function person(prefix: string) {
  const user = await createTestUser(`pay-${prefix}`);
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

const NA = { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "2500000", billingPeriod: "one_time", durationDays: 30 };

/** Assisted chain through the real API: proposal → send → acceptance by the OWNER → pending contract (no payment). */
async function pendingContract() {
  const owner = await person("owner");
  const org = await createTestOrganization("pay-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const created = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "Cliente", recipientName: "Dest", recipientEmail: owner.user.email, organizationId: org.id, validUntil: future(), termsTemplateId: termsId });
  assert.equal(created.status, 201, created.raw);
  const proposalId = created.data.id as string;
  const versionId = created.data.versions[0].id as string;
  const v = `/platform/proposals/${proposalId}/versions/${versionId}`;
  const optionId = (await call("POST", `${v}/options`, admin.token, { name: "Opção", isRecommended: true })).data.options[0].id as string;
  assert.equal((await call("POST", `${v}/options/${optionId}/items`, admin.token, NA)).status, 201);
  const sent = await call("POST", `${v}/send`, admin.token);
  assert.equal(sent.status, 200, sent.raw);
  const acc = await call("POST", `/proposals/${proposalId}/acceptance`, owner.token, { versionId, optionId, contentSha256: sent.data.contentSha256, signerName: "Signatário", consent: true }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(acc.status, 201, acc.raw);
  return { contractId: acc.data.contract.id as string, orgId: org.id, owner };
}

const manual = (contractId: string, body: Record<string, unknown>, token = admin.token, key = `pay-${randomUUID()}`) =>
  call("POST", `/platform/contracts/${contractId}/payments`, token, body, { "idempotency-key": key });
const integration = (body: Record<string, unknown>, token = michaToken, key = `mx-${randomUUID()}`) =>
  call("POST", "/service/payments/confirmations", token, body, { "idempotency-key": key });
const paid = (overrides: Record<string, unknown> = {}) => ({ amountMinor: "2500000", currency: "AOA", method: "bank_transfer", externalReference: `TRF-${randomUUID()}`, receivedAt: new Date().toISOString(), evidenceReference: "ticket UL-FIN-123", ...overrides });

/** Drizzle wraps the driver error; the trigger/constraint message is on the cause chain. */
function pgMessage(error: unknown): string {
  let e = error as { message?: string; cause?: unknown } | undefined;
  const parts: string[] = [];
  while (e) {
    if (e.message) parts.push(e.message);
    e = e.cause as typeof e;
  }
  return parts.join(" | ");
}
const rejectsWith = (fn: () => Promise<unknown>, re: RegExp, msg?: string) => assert.rejects(fn, (error: unknown) => re.test(pgMessage(error)), msg);

async function paymentsOf(contractId: string) {
  return db.select().from(commercialPayments).where(eq(commercialPayments.contractId, contractId));
}
async function activeGrants(orgId: string) {
  const [r] = await db.select({ n: count() }).from(entitlementGrants).where(and(eq(entitlementGrants.organizationId, orgId), eq(entitlementGrants.status, "active")));
  return r!.n;
}

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  admin = await platformPerson("PLATFORM_ADMIN");
  // A platform member WITHOUT platform.payment.confirm (read + entitlement grant only).
  const [role] = await db.insert(platformRoles).values({ key: `TEST_PAY_NOCONFIRM_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test without payment permission" }).returning();
  readOnlyRoleId = role!.id;
  for (const key of ["platform.commercial.read", "platform.entitlement.grant"]) {
    const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, key));
    await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  }
  readOnly = await platformPerson(role!.key);
  const body = `Termos de TESTE ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`pay-${randomUUID().slice(0, 8)}`}, 1, 'Termos', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
  const key = await createPlatformApiKey({ applicationKey: "MICHA_EXPRESS", actorUserId: admin.user.id, scopes: ["payment.confirm"] });
  michaToken = key.secret;
  michaKeyId = key.id;
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

test("T05/T20 — assisted contract with the payment pending: activation refused (PAYMENT_NOT_CONFIRMED), no access", async () => {
  const { contractId, orgId } = await pendingContract();
  const res = await call("POST", `/platform/contracts/${contractId}/activation`, admin.token);
  assert.equal(res.status, 409);
  assert.equal(res.code, "PAYMENT_NOT_CONFIRMED");
  assert.equal(await activeGrants(orgId), 0);
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "pending_activation");
});

test("T07 — manual confirmation without platform.payment.confirm is refused, and nothing is recorded", async () => {
  const { contractId, owner } = await pendingContract();
  assert.equal((await manual(contractId, paid(), readOnly.token)).status, 403, "platform member without the permission");
  assert.equal((await manual(contractId, paid(), owner.token)).status, 403, "the organization's own OWNER");
  assert.equal((await manual(contractId, paid(), "")).status, 401, "no credential");
  assert.equal((await manual(contractId, paid(), michaToken)).status, 403, "a service credential never reaches the manual route");
  assert.equal((await paymentsOf(contractId)).length, 0);
});

test("T06 — amount or currency different from the contract: rejected (409 PAYMENT_AMOUNT_MISMATCH), nothing recorded", async () => {
  const { contractId } = await pendingContract();
  for (const body of [paid({ amountMinor: "2499999" }), paid({ amountMinor: "5000000" }), paid({ currency: "USD" })]) {
    const res = await manual(contractId, body);
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.code, "PAYMENT_AMOUNT_MISMATCH");
  }
  assert.equal((await manual(contractId, paid({ amountMinor: "25000.00" }))).status, 400, "minor units only, never a decimal");
  assert.equal((await manual(contractId, paid({ receivedAt: future(3_600_000) }))).status, 400, "a payment cannot be received in the future");
  assert.equal((await manual(contractId, paid(), admin.token, "bad key")).status, 400, "Idempotency-Key required");
  assert.equal((await manual(contractId, { ...paid(), payment_confirmed: true })).status, 400, "unknown fields are refused (strict)");
  assert.equal((await paymentsOf(contractId)).length, 0);
});

test("manual methods are the approved ones only (bank_transfer, multicaixa_express) and the evidence is mandatory", async () => {
  const { contractId } = await pendingContract();
  for (const method of ["cash", "multicaixa_reference", "micha_express"]) {
    assert.equal((await manual(contractId, paid({ method }))).status, 400, method);
  }
  const { evidenceReference: _omit, ...withoutEvidence } = paid();
  assert.equal((await manual(contractId, withoutEvidence)).status, 400, "evidence required");
  assert.equal((await manual(contractId, paid({ evidenceReference: "  " }))).status, 400, "blank evidence");
  assert.equal((await paymentsOf(contractId)).length, 0);
  const mcx = await manual(contractId, paid({ method: "multicaixa_express", externalReference: `MCX-${randomUUID()}`, evidenceReference: "REC-MCX-1" }));
  assert.equal(mcx.status, 201, mcx.raw);
  assert.equal(mcx.data.payment.method, "multicaixa_express");
  // The administrators' contract view carries the full payment record.
  const view = await call("GET", `/platform/contracts/${contractId}`, admin.token);
  assert.equal(view.data.payment.method, "multicaixa_express");
  assert.equal(view.data.payment.evidenceReference, "REC-MCX-1");
  assert.equal(view.data.payment.confirmedByUserId, admin.user.id);
});

test("T08/T19/T01 — an authorized admin confirms the exact amount: recorded with evidence and audit, then the SAME activation path activates", async () => {
  const { contractId, orgId, owner } = await pendingContract();
  const body = paid();
  const res = await manual(contractId, body);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.payment.source, "manual");
  assert.equal(res.data.payment.confirmedByUserId, admin.user.id);
  assert.equal(res.data.payment.amountMinor, "2500000");
  assert.equal(res.data.activation.activated, true);
  const [row] = await paymentsOf(contractId);
  assert.equal(row!.evidenceReference, "ticket UL-FIN-123");
  assert.equal(row!.method, "bank_transfer");
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "active");
  assert.equal(c!.endsAt!.getTime() - c!.startsAt!.getTime(), 30 * 86_400_000, "30 days, not a calendar month");
  const [grant] = await db.select().from(entitlementGrants).where(eq(entitlementGrants.contractId, contractId));
  assert.equal(grant!.activatedBy, admin.user.id);
  assert.equal(grant!.activatedByApiKeyId, null);
  assert.equal(await activeGrants(orgId), 1);
  const audits = await db.select({ action: auditLogs.action, metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.targetId, contractId));
  const paymentAudit = audits.find((a) => a.action === "platform.commercial.payment.confirmed");
  assert.ok(paymentAudit, "payment confirmation audited");
  assert.ok(!JSON.stringify(paymentAudit!.metadata).includes(body.externalReference), "no reference in the audit trail");
  assert.ok(audits.some((a) => a.action === "platform.commercial.contract.activated"));
  const events = (await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, row!.id))).map((e) => e.t);
  assert.deepEqual(events, ["payment.confirmed"]);
  // The client sees the payment status — never the evidence or who confirmed.
  const view = await call("GET", `/organizations/${orgId}/contracts/${contractId}`, owner.token);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.data.payment.status, "confirmed");
  assert.ok(!view.raw.includes("UL-FIN-123") && !view.raw.includes(admin.user.id));
});

test("T09/T17 — duplicates: same key replays; same reference elsewhere, a second payment, or the key reused with another body are 409", async () => {
  const a = await pendingContract();
  const b = await pendingContract();
  const body = paid();
  const key = `pay-${randomUUID()}`;
  assert.equal((await manual(a.contractId, body, admin.token, key)).status, 201);
  const replay = await manual(a.contractId, body, admin.token, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.activation.alreadyActive, true, "a replay never activates twice");
  assert.equal((await manual(a.contractId, { ...body, amountMinor: "1" }, admin.token, key)).code, "CONFLICT", "same key, other body");
  const sameRef = await manual(b.contractId, { ...paid(), externalReference: body.externalReference });
  assert.equal(sameRef.status, 409);
  assert.equal(sameRef.code, "PAYMENT_REFERENCE_IN_USE");
  const second = await manual(a.contractId, paid());
  assert.equal(second.status, 409);
  assert.equal(second.code, "PAYMENT_ALREADY_CONFIRMED");
  assert.equal((await paymentsOf(a.contractId)).length, 1);
  assert.equal((await paymentsOf(b.contractId)).length, 0);
  assert.equal(await activeGrants(a.orgId), 1, "one set of rights");
});

test("T02 — organization suspended: the payment is recorded but activation is blocked; once reactivated, activation succeeds", async () => {
  const { contractId, orgId } = await pendingContract();
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgId));
  const res = await manual(contractId, paid());
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.activation.activated, false);
  assert.equal(res.data.activation.blocker.code, "ORGANIZATION_SUSPENDED");
  assert.equal(await activeGrants(orgId), 0);
  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgId));
  const act = await call("POST", `/platform/contracts/${contractId}/activation`, admin.token);
  assert.equal(act.status, 201, act.raw);
  assert.equal(await activeGrants(orgId), 1);
});

test("a cancelled contract cannot receive a payment confirmation (CONTRACT_NOT_PAYABLE)", async () => {
  const { contractId } = await pendingContract();
  assert.equal((await call("POST", `/platform/contracts/${contractId}/cancellation`, admin.token)).status, 200);
  const res = await manual(contractId, paid());
  assert.equal(res.status, 409);
  assert.equal(res.code, "CONTRACT_NOT_PAYABLE");
});

test("integration — an authenticated MICHA_EXPRESS platform credential confirms; the platform itself activates (system actor)", async () => {
  const { contractId, orgId } = await pendingContract();
  const body = { contractId, amountMinor: "2500000", currency: "AOA", externalReference: `MX-${randomUUID()}`, receivedAt: new Date().toISOString() };
  const res = await integration(body);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.payment.source, "integration");
  assert.equal(res.data.payment.method, "micha_express", "the method is the confirming application, never a request field");
  assert.equal(res.data.payment.confirmedByApiKeyId, michaKeyId);
  assert.equal(res.data.activation.activated, true);
  const [grant] = await db.select().from(entitlementGrants).where(eq(entitlementGrants.contractId, contractId));
  assert.equal(grant!.status, "active");
  assert.equal(grant!.activatedBy, null);
  assert.equal(grant!.activatedByApiKeyId, michaKeyId);
  const [ev] = await db.select({ actorType: commercialEvents.actorType }).from(commercialEvents).where(and(eq(commercialEvents.aggregateId, contractId), eq(commercialEvents.eventType, "contract.activated")));
  assert.equal(ev!.actorType, "system");
  assert.equal(await activeGrants(orgId), 1);
  // A re-delivered notice (new key, same content) is not a second payment.
  const again = await integration(body);
  assert.equal(again.status, 200);
  assert.equal((await paymentsOf(contractId)).length, 1);
});

test("integration authority — scope, credential class and application are enforced; the body cannot carry authority", async () => {
  const { contractId, orgId } = await pendingContract();
  const body = { contractId, amountMinor: "2500000", currency: "AOA", externalReference: `MX-${randomUUID()}`, receivedAt: new Date().toISOString() };
  const noScope = await createPlatformApiKey({ applicationKey: "MICHA_EXPRESS", actorUserId: admin.user.id });
  assert.equal((await integration(body, noScope.secret)).status, 403, "MICHA_EXPRESS key without payment.confirm");
  await assert.rejects(() => createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: admin.user.id, scopes: ["payment.confirm"] }), "the scope is allow-listed for MICHA_EXPRESS only");
  await grantTestApplicationAccess(orgId, "MICHA_EXPRESS");
  const orgKey = await createOrganizationApiKey({ organizationId: orgId, applicationKey: "MICHA_EXPRESS", actorUserId: admin.user.id, scopes: ["payment.confirm"] });
  assert.equal((await integration(body, orgKey.secret)).status, 403, "an organization credential cannot confirm payments");
  assert.equal((await integration(body, admin.token)).status, 403, "a human session cannot use the service route");
  assert.equal((await integration({ ...body, method: "cash" })).status, 400, "no method field on the integration route");
  assert.equal((await integration({ ...body, amountMinor: "100" })).code, "PAYMENT_AMOUNT_MISMATCH");
  assert.equal((await paymentsOf(contractId)).length, 0);
});

test("T10 — concurrent confirmations (different keys) and activations of one contract: one payment, one set of rights", async () => {
  const { contractId, orgId } = await pendingContract();
  const results = await Promise.all([
    ...Array.from({ length: 4 }, () => manual(contractId, paid())),
    ...Array.from({ length: 3 }, () => call("POST", `/platform/contracts/${contractId}/activation`, admin.token)),
  ]);
  assert.equal(results.filter((r) => r.status === 201 && r.data?.payment && "replayed" in r.data).length, 1, results.map((r) => `${r.status}:${r.code}`).join(","));
  assert.ok(results.every((r) => [200, 201, 409].includes(r.status)), results.map((r) => r.status).join(","));
  assert.equal((await paymentsOf(contractId)).length, 1);
  if ((await db.select().from(contracts).where(eq(contracts.id, contractId)))[0]!.status !== "active") {
    assert.equal((await call("POST", `/platform/contracts/${contractId}/activation`, admin.token)).status, 201);
  }
  assert.equal(await activeGrants(orgId), 1);
  const [subs] = await db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.organizationId, orgId));
  assert.equal(subs!.n, 1);
});

test("database guards: payments are append-only and must match their contract even through direct SQL", async () => {
  const { contractId, orgId } = await pendingContract();
  await manual(contractId, paid());
  const [row] = await paymentsOf(contractId);
  await rejectsWith(() => db.execute(sql`update commercial_payments set amount_minor = 1 where id = ${row!.id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`delete from commercial_payments where id = ${row!.id}`), /immutable/);
  const other = await pendingContract();
  await rejectsWith(
    () => db.execute(sql`insert into commercial_payments (contract_id, organization_id, source, method, amount_minor, currency, external_reference, received_at, confirmed_by_user_id, idempotency_key)
      values (${other.contractId}, ${other.orgId}, 'manual', 'cash', 1, 'AOA', ${`sql-${randomUUID()}`}, now(), ${admin.user.id}, ${`sql-${randomUUID()}`})`),
    /amount\/currency do not match/,
  );
  await rejectsWith(
    () => db.execute(sql`insert into commercial_payments (contract_id, organization_id, source, method, amount_minor, currency, external_reference, received_at, idempotency_key)
      values (${other.contractId}, ${other.orgId}, 'manual', 'cash', 2500000, 'AOA', ${`sql-${randomUUID()}`}, now(), ${`sql-${randomUUID()}`})`),
    /confirmer_check/,
    "a manual confirmation always names the administrator",
  );
  assert.ok(orgId);
});

test("T14 — expiry: an active contract past its end becomes expired, its grant expired, subscription canceled and access revoked (persisted, idempotent)", async () => {
  const { contractId, orgId, owner } = await pendingContract();
  assert.equal((await manual(contractId, paid())).data.activation.activated, true);
  // Move the period into the past (the dates are not identity: contracts_guard and the grant guard allow it).
  await db.execute(sql`update entitlement_grants set starts_at = now() - interval '31 days', ends_at = now() - interval '1 day' where contract_id = ${contractId}`);
  await db.execute(sql`update contracts set starts_at = now() - interval '31 days', ends_at = now() - interval '1 day' where id = ${contractId}`);
  const first = await expireDueContracts();
  assert.ok(first.expired.includes(contractId));
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "expired");
  const [grant] = await db.select().from(entitlementGrants).where(eq(entitlementGrants.contractId, contractId));
  assert.equal(grant!.status, "expired");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, grant!.subscriptionId!));
  assert.equal(sub!.status, "canceled");
  const [access] = await db.select().from(organizationApplicationAccess).where(eq(organizationApplicationAccess.id, grant!.applicationAccessId!));
  assert.equal(access!.status, "revoked");
  const types = (await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, contractId))).map((e) => e.t);
  assert.ok(types.includes("contract.expired"));
  assert.ok(!(await expireDueContracts()).expired.includes(contractId), "re-running changes nothing");
  const key = await call("POST", `/organizations/${orgId}/api-keys`, owner.token, { applicationKey: "NA_PISTA" });
  assert.equal(key.status, 403);
  assert.equal(key.code, "APPLICATION_ACCESS_REQUIRED");
});

test("T18 — another organization's OWNER cannot see this contract or its payment", async () => {
  const a = await pendingContract();
  await manual(a.contractId, paid());
  const b = await pendingContract();
  const res = await call("GET", `/organizations/${b.orgId}/contracts/${a.contractId}`, b.owner.token);
  assert.equal(res.status, 404);
  assert.ok([403, 404].includes((await call("GET", `/organizations/${a.orgId}/contracts/${a.contractId}`, b.owner.token)).status));
});
