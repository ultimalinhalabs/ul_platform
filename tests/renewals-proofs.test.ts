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
  commercialPayments,
  contractRenewals,
  contracts,
  emailOutbox,
  entitlementGrants,
  memberships,
  organizations,
  paymentProofs,
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  roles,
  subscriptions,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createPlatformApiKey } from "../src/modules/apiKeys/service.js";
import { expireDueContracts } from "../src/modules/commercial/activation.service.js";
import { prepareDueRenewals, prepareRenewalForContract } from "../src/modules/commercial/renewals.service.js";
import { createTestOrganization, createTestUser } from "./helpers.js";

/**
 * Migrations 0026/0027 — renewal with manual payment confirmation (spec §6.2, T11–T13) and the client's PDF proof
 * of payment (owner decision 2026-10-16), over HTTP; plus the failure/concurrency cases of the payment step (step 4).
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies vary per assertion
type Res = { status: number; data: any; code?: string; raw: string; headers: Headers; bytes?: Buffer };
type User = Awaited<ReturnType<typeof createTestUser>>;

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setIssuer(EXPECTED_ISSUER).setExpirationTime("10m").sign(secret);
}
async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const isBuffer = Buffer.isBuffer(body);
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !isBuffer ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isBuffer ? new Uint8Array(body as Buffer) : JSON.stringify(body),
  });
  if ((res.headers.get("content-type") ?? "").startsWith("application/pdf")) {
    return { status: res.status, data: null, raw: "", headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : null;
  return { status: res.status, data: json?.data, code: json?.error?.code, raw, headers: res.headers };
}

const createdAuthUsers: string[] = [];
const platformUsers: string[] = [];
let noProofRoleId: string | undefined;
let admin: { user: User; token: string };
/** Several administrators: confirmations are rate limited per user (30/min) and this suite confirms many. */
const admins: { user: User; token: string }[] = [];
let nextAdminIdx = 0;
const anyAdmin = () => admins[nextAdminIdx++ % admins.length]!.token;
let noProofReader: { user: User; token: string };
let termsId: string;
let michaToken: string;

async function person(prefix: string) {
  const user = await createTestUser(`ren-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, now())`);
  return { user, token: await tokenFor(user) };
}
async function platformPerson(roleKey: string) {
  const p = await person(`platform-${roleKey.toLowerCase().slice(0, 12)}`);
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, roleKey));
  await db.insert(platformMemberships).values({ userId: p.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  platformUsers.push(p.user.id);
  return p;
}

const NA = { kind: "application_plan", title: "Na Pista Crescimento", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "2500000", billingPeriod: "one_time", durationDays: 30 };

async function memberOf(orgId: string, roleKey: string) {
  const p = await person(roleKey.toLowerCase());
  const [role] = await db.select().from(roles).where(eq(roles.key, roleKey));
  await db.insert(memberships).values({ userId: p.user.id, organizationId: orgId, roleId: role!.id, status: "active" });
  return p;
}

/** Assisted chain through the real API: proposal → send → acceptance by the OWNER → pending contract. */
async function pendingContract() {
  const owner = await person("owner");
  const org = await createTestOrganization("ren-org", owner.user.id);
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

const manual = (contractId: string, body: Record<string, unknown>, token = anyAdmin(), key = `pay-${randomUUID()}`) =>
  call("POST", `/platform/contracts/${contractId}/payments`, token, body, { "idempotency-key": key });
const paid = (overrides: Record<string, unknown> = {}) => ({ amountMinor: "2500000", currency: "AOA", method: "bank_transfer", externalReference: `TRF-${randomUUID()}`, receivedAt: new Date().toISOString(), evidenceReference: "REC-UL-0001", ...overrides });

/** An ACTIVE 30-day contract (paid and activated). */
async function activeContract() {
  const c = await pendingContract();
  const res = await manual(c.contractId, paid());
  assert.equal(res.data?.activation?.activated, true, res.raw);
  return c;
}

const contractPath = (c: { orgId: string; contractId: string }) => `/organizations/${c.orgId}/contracts/${c.contractId}`;
async function authorize(c: { orgId: string; contractId: string; owner: { token: string } }, key = `ren-${randomUUID()}`) {
  const detail = await call("GET", contractPath(c), c.owner.token);
  assert.equal(detail.status, 200, detail.raw);
  assert.ok(detail.data.renewal.offer, "an active renewable contract offers renewal");
  return call("POST", `${contractPath(c)}/renewal-authorization`, c.owner.token, { consent: true, consentSha256: detail.data.renewal.offer.consentSha256 }, { "idempotency-key": key });
}
/** Moves the current period so it ends in `days` days (the dates are not identity). */
async function endsIn(contractId: string, days: number) {
  await db.execute(sql`update entitlement_grants set starts_at = now() - interval '20 days', ends_at = now() + make_interval(days => ${days}) where contract_id = ${contractId} and status = 'active'`);
  await db.execute(sql`update contracts set starts_at = now() - interval '20 days', ends_at = now() + make_interval(days => ${days}) where id = ${contractId}`);
  const [grant] = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.contractId, contractId), eq(entitlementGrants.status, "active")));
  if (grant?.subscriptionId) await db.execute(sql`update subscriptions set current_period_end = now() + make_interval(days => ${days}) where id = ${grant.subscriptionId}`);
}
const renewalsOf = (contractId: string) => db.select().from(contractRenewals).where(eq(contractRenewals.contractId, contractId));
const outboxFor = (kind: string, to?: string) => db.select().from(emailOutbox).where(to ? and(eq(emailOutbox.kind, kind), eq(emailOutbox.toEmail, to.toLowerCase())) : eq(emailOutbox.kind, kind));

const PDF = (tag: string = randomUUID()) => Buffer.from(`%PDF-1.4\n% comprovativo de teste ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
const upload = (c: { orgId: string; contractId: string; owner: { token: string } }, file: Buffer, q: Record<string, string> = {}, token = c.owner.token) =>
  call("POST", `${contractPath(c)}/payment-proofs?${new URLSearchParams({ method: "bank_transfer", reference: "TRF-CLIENTE-1", fileName: "talão.pdf", ...q })}`, token, file, { "content-type": "application/pdf" });

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

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  admin = await platformPerson("PLATFORM_ADMIN");
  for (let i = 0; i < 8; i++) admins.push(await platformPerson("PLATFORM_ADMIN"));
  const [role] = await db.insert(platformRoles).values({ key: `TEST_NO_PROOF_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test without proof read" }).returning();
  noProofRoleId = role!.id;
  for (const key of ["platform.commercial.read"]) {
    const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, key));
    await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  }
  noProofReader = await platformPerson(role!.key);
  const body = `Termos de TESTE ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`ren-${randomUUID().slice(0, 8)}`}, 1, 'Termos', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
  michaToken = (await createPlatformApiKey({ applicationKey: "MICHA_EXPRESS", actorUserId: admin.user.id, scopes: ["payment.confirm"] })).secret;
});

after(async () => {
  server.close();
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  if (noProofRoleId) {
    await db.delete(platformRolePermissions).where(eq(platformRolePermissions.platformRoleId, noProofRoleId));
    await db.delete(platformRoles).where(eq(platformRoles.id, noProofRoleId));
  }
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

// ============================================================================ renewal

test("renewal offer: shown only to the OWNER of an active renewable contract, with the exact text and its hash", async () => {
  const pending = await pendingContract();
  const before = await call("GET", contractPath(pending), pending.owner.token);
  assert.equal(before.data.renewal.offer, null, "nothing to renew before activation");
  assert.equal(before.data.renewal.ineligibleReason, "CONTRACT_NOT_ACTIVE");
  const c = await activeContract();
  const detail = await call("GET", contractPath(c), c.owner.token);
  const offer = detail.data.renewal.offer;
  assert.equal(offer.amountMinor, "2500000");
  assert.equal(offer.periodDays, 30);
  assert.match(offer.consentText, /25 000,00 Kz/);
  assert.match(offer.consentText, /não é uma cobrança automática/);
  assert.match(offer.consentText, /retirar esta autorização/);
  assert.equal(offer.consentSha256, sha(offer.consentText));
  const staff = await memberOf(c.orgId, "STAFF");
  assert.equal((await call("POST", `${contractPath(c)}/renewal-authorization`, staff.token, { consent: true, consentSha256: offer.consentSha256 }, { "idempotency-key": `k-${randomUUID()}` })).status, 403);
  const other = await activeContract();
  assert.equal((await call("POST", `/organizations/${other.orgId}/contracts/${c.contractId}/renewal-authorization`, other.owner.token, { consent: true, consentSha256: offer.consentSha256 }, { "idempotency-key": `k-${randomUUID()}` })).status, 404);
});

test("authorization: recorded with text/hash/price; outdated text refused; idempotent replay; a second one refused", async () => {
  const c = await activeContract();
  const wrong = await call("POST", `${contractPath(c)}/renewal-authorization`, c.owner.token, { consent: true, consentSha256: "0".repeat(64) }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.code, "CONSENT_OUTDATED");
  assert.equal((await call("POST", `${contractPath(c)}/renewal-authorization`, c.owner.token, { consent: true }, { "idempotency-key": `k-${randomUUID()}` })).status, 400);
  const key = `ren-${randomUUID()}`;
  const ok1 = await authorize(c, key);
  assert.equal(ok1.status, 201, ok1.raw);
  assert.equal(ok1.data.amountMinor, "2500000");
  assert.equal(ok1.data.authorizedByUserId, c.owner.user.id);
  const replay = await call("POST", `${contractPath(c)}/renewal-authorization`, c.owner.token, { consent: true, consentSha256: ok1.data.consentSha256 }, { "idempotency-key": key });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, ok1.data.id);
  const second = await call("POST", `${contractPath(c)}/renewal-authorization`, c.owner.token, { consent: true, consentSha256: ok1.data.consentSha256 }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(second.code, "RENEWAL_ALREADY_AUTHORIZED");
  const [audit] = await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "commercial.contract.renewal.authorized"), eq(auditLogs.targetId, c.contractId)));
  assert.equal(audit!.n, 1);
  // Outside the lead window (30 days left): nothing is prepared yet.
  assert.equal((await renewalsOf(c.contractId)).length, 0);
});

test("T11 — authorized renewal inside the lead window: one renewal awaiting payment, new period NOT active, owners emailed", async () => {
  const c = await activeContract();
  assert.equal((await authorize(c)).status, 201);
  await endsIn(c.contractId, 3);
  const [contractBefore] = await db.select().from(contracts).where(eq(contracts.id, c.contractId));
  const sweep = await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  assert.ok(sweep.created.includes(r!.id));
  assert.equal(r!.status, "awaiting_payment");
  assert.equal(r!.sequence, 1);
  assert.equal(r!.amountMinor, 2500000n);
  assert.equal(r!.periodStartsAt.getTime(), contractBefore!.endsAt!.getTime(), "the new period starts where the current one ends");
  assert.equal(r!.periodEndsAt.getTime() - r!.periodStartsAt.getTime(), 30 * 86_400_000);
  const [contractAfter] = await db.select().from(contracts).where(eq(contracts.id, c.contractId));
  assert.equal(contractAfter!.endsAt!.getTime(), contractBefore!.endsAt!.getTime(), "nothing is extended before payment");
  const mails = await outboxFor("commercial.contract.renewal.created", c.owner.user.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0]!.bodyText, /não é uma cobrança automática/);
  assert.match(mails[0]!.bodyText, /-R1/);
  // Re-running (and racing) the sweep never creates a second renewal for the same period.
  await Promise.all(Array.from({ length: 5 }, () => prepareRenewalForContract(c.contractId)));
  await prepareDueRenewals();
  assert.equal((await renewalsOf(c.contractId)).length, 1);
  const detail = await call("GET", contractPath(c), c.owner.token);
  assert.equal(detail.data.renewal.renewals[0].status, "awaiting_payment");
  assert.match(detail.data.renewal.renewals[0].reference, /^UL-C-\d{4}-\d{6,}-R1$/);
});

test("authorizing when already inside the lead window prepares the renewal at once", async () => {
  const c = await activeContract();
  await endsIn(c.contractId, 2);
  assert.equal((await authorize(c)).status, 201);
  assert.equal((await renewalsOf(c.contractId))[0]?.status, "awaiting_payment");
});

test("T12 — renewal paid: the new period becomes active exactly once (contract, grant and subscription extended)", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  const wrong = await manual(c.contractId, paid({ renewalId: r!.id, amountMinor: "100" }));
  assert.equal(wrong.code, "PAYMENT_AMOUNT_MISMATCH");
  const body = paid({ renewalId: r!.id });
  const key = `pay-${randomUUID()}`;
  const ok1 = await manual(c.contractId, body, admin.token, key);
  assert.equal(ok1.status, 201, ok1.raw);
  assert.equal(ok1.data.payment.renewalId, r!.id);
  assert.equal(ok1.data.activation.activated, true);
  const [after] = await renewalsOf(c.contractId);
  assert.equal(after!.status, "active");
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, c.contractId));
  assert.equal(contract!.endsAt!.getTime(), r!.periodEndsAt.getTime());
  const [grant] = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.contractId, c.contractId), eq(entitlementGrants.status, "active")));
  assert.equal(grant!.endsAt!.getTime(), r!.periodEndsAt.getTime());
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, grant!.subscriptionId!));
  assert.equal(sub!.currentPeriodEnd!.getTime(), r!.periodEndsAt.getTime());
  // Replays and duplicates never extend twice.
  assert.equal((await manual(c.contractId, body, admin.token, key)).status, 200);
  const other = await manual(c.contractId, paid({ renewalId: r!.id }));
  assert.equal(other.code, "PAYMENT_ALREADY_CONFIRMED");
  const again = await call("POST", `/platform/renewals/${r!.id}/activation`, admin.token);
  assert.equal(again.status, 200);
  assert.equal(again.data.applied, false);
  const [c2] = await db.select().from(contracts).where(eq(contracts.id, c.contractId));
  assert.equal(c2!.endsAt!.getTime(), r!.periodEndsAt.getTime(), "still extended exactly once");
  // The first-period payment and the renewal payment coexist; the first period is still the contract's own.
  const [pays] = await db.select({ n: count() }).from(commercialPayments).where(eq(commercialPayments.contractId, c.contractId));
  assert.equal(pays!.n, 2);
  // The next cycle can be prepared again from the new end (sequence 2).
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  assert.deepEqual((await renewalsOf(c.contractId)).map((x) => x.sequence).sort(), [1, 2]);
});

test("T12 (integration) — a renewal can be confirmed by the payments integration; the system applies it", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  const res = await call("POST", "/service/payments/confirmations", michaToken, { contractId: c.contractId, renewalId: r!.id, amountMinor: "2500000", currency: "AOA", externalReference: `MX-${randomUUID()}`, receivedAt: new Date().toISOString() }, { "idempotency-key": `mx-${randomUUID()}` });
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.data.activation.activated, true);
  assert.equal((await renewalsOf(c.contractId))[0]!.status, "active");
});

test("T13 — authorization withdrawn before renewal: no renewal is created", async () => {
  const c = await activeContract();
  await authorize(c);
  const w = await call("POST", `${contractPath(c)}/renewal-authorization/withdrawal`, c.owner.token);
  assert.equal(w.status, 200);
  assert.equal(w.data.withdrawn, true);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  assert.equal((await renewalsOf(c.contractId)).length, 0);
  // Withdrawing again is harmless; a new authorization is possible.
  assert.equal((await call("POST", `${contractPath(c)}/renewal-authorization/withdrawal`, c.owner.token)).data.withdrawn, false);
  assert.equal((await authorize(c)).status, 201);
});

test("T13 — withdrawn after the renewal was prepared but before payment: the renewal is cancelled and cannot be paid", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  const w = await call("POST", `${contractPath(c)}/renewal-authorization/withdrawal`, c.owner.token);
  assert.equal(w.data.cancelledRenewalId, r!.id);
  assert.equal((await renewalsOf(c.contractId))[0]!.status, "cancelled");
  const pay = await manual(c.contractId, paid({ renewalId: r!.id }));
  assert.equal(pay.code, "RENEWAL_NOT_PAYABLE");
});

test("no valid paid renewal: when the period ends the renewal lapses and access ends (T14 with renewal)", async () => {
  const c = await activeContract();
  await authorize(c);
  // The current period ends in 2 seconds; the renewal (prepared now) starts then. Its start is identity, so wait.
  await db.execute(sql`update entitlement_grants set ends_at = now() + interval '2 seconds' where contract_id = ${c.contractId} and status = 'active'`);
  await db.execute(sql`update contracts set ends_at = now() + interval '2 seconds' where id = ${c.contractId}`);
  await prepareDueRenewals();
  assert.equal((await renewalsOf(c.contractId))[0]?.status, "awaiting_payment");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const res = await expireDueContracts();
  assert.ok(res.expired.includes(c.contractId));
  const [r] = await renewalsOf(c.contractId);
  assert.equal(r!.status, "lapsed");
  const pay = await manual(c.contractId, paid({ renewalId: r!.id }));
  assert.equal(pay.status, 409, "a lapsed renewal cannot be paid");
});

test("suspended organization: the renewal payment is recorded but not applied; once reactivated, applied explicitly", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, c.orgId));
  const res = await manual(c.contractId, paid({ renewalId: r!.id }));
  assert.equal(res.status, 201);
  assert.equal(res.data.activation.activated, false);
  assert.equal(res.data.activation.blocker.code, "ORGANIZATION_SUSPENDED");
  assert.equal((await renewalsOf(c.contractId))[0]!.status, "awaiting_payment");
  // A withdrawal does not cancel a renewal that is already paid.
  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, c.orgId));
  assert.equal((await call("POST", `${contractPath(c)}/renewal-authorization/withdrawal`, c.owner.token)).data.cancelledRenewalId, null);
  const applied = await call("POST", `/platform/renewals/${r!.id}/activation`, admin.token);
  assert.equal(applied.status, 201, applied.raw);
  assert.equal((await renewalsOf(c.contractId))[0]!.status, "active");
});

test("concurrency — several renewal confirmations at once: one payment, the period extended once", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  const results = await Promise.all(Array.from({ length: 5 }, () => manual(c.contractId, paid({ renewalId: r!.id }))));
  assert.equal(results.filter((x) => x.status === 201).length, 1, results.map((x) => `${x.status}:${x.code}`).join(","));
  const [n] = await db.select({ n: count() }).from(commercialPayments).where(eq(commercialPayments.renewalId, r!.id));
  assert.equal(n!.n, 1);
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, c.contractId));
  assert.equal(contract!.endsAt!.getTime(), r!.periodEndsAt.getTime());
});

test("database guards: renewals and authorizations are history even through direct SQL", async () => {
  const c = await activeContract();
  const a = await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  await rejectsWith(() => db.execute(sql`update contract_renewal_authorizations set amount_minor = 1 where id = ${a.data.id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`delete from contract_renewal_authorizations where id = ${a.data.id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`update contract_renewals set amount_minor = 1 where id = ${r!.id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`update contract_renewals set status = 'active' where id = ${r!.id}`), /applied_check/);
  await rejectsWith(() => db.execute(sql`delete from contract_renewals where id = ${r!.id}`), /immutable/);
  await rejectsWith(
    () => db.execute(sql`insert into commercial_payments (contract_id, organization_id, source, method, amount_minor, currency, external_reference, received_at, confirmed_by_user_id, idempotency_key, renewal_id)
      values (${c.contractId}, ${c.orgId}, 'manual', 'bank_transfer', 1, 'AOA', ${`sql-${randomUUID()}`}, now(), ${admin.user.id}, ${`sql-${randomUUID()}`}, ${r!.id})`),
    /do not match the renewal/,
  );
});

// ============================================================================ payment instructions and proofs

test("payment instructions: amount, reference and only the configured methods; nothing to pay → 409", async () => {
  const c = await pendingContract();
  const saved = { iban: env.PAYMENT_IBAN, mcx: env.PAYMENT_MCX_EXPRESS_NUMBER, bank: env.PAYMENT_BANK_NAME };
  try {
    env.PAYMENT_IBAN = "AO06 0000 0000 0000 0000 0000 0";
    env.PAYMENT_BANK_NAME = "Banco de Teste";
    env.PAYMENT_MCX_EXPRESS_NUMBER = undefined;
    const res = await call("GET", `${contractPath(c)}/payment-instructions`, c.owner.token);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.data.target.kind, "contract");
    assert.equal(res.data.target.amountMinor, "2500000");
    assert.match(res.data.target.reference, /^UL-C-/);
    assert.equal(res.data.methods.bankTransfer.iban, "AO06 0000 0000 0000 0000 0000 0");
    assert.equal(res.data.methods.multicaixaExpress, null, "an unconfigured method is not offered");
    assert.equal(res.data.proof.required, true);
  } finally {
    env.PAYMENT_IBAN = saved.iban;
    env.PAYMENT_MCX_EXPRESS_NUMBER = saved.mcx;
    env.PAYMENT_BANK_NAME = saved.bank;
  }
  const staff = await memberOf(c.orgId, "STAFF");
  assert.equal((await call("GET", `${contractPath(c)}/payment-instructions`, staff.token)).status, 403);
  const active = await activeContract();
  assert.equal((await call("GET", `${contractPath(active)}/payment-instructions`, active.owner.token)).code, "NOTHING_TO_PAY");
});

test("proof upload: only a real PDF up to 4 MB, by the OWNER of this organization; the same file is one proof", async () => {
  const c = await pendingContract();
  const notPdf = await upload(c, Buffer.from("<html>not a pdf</html>"));
  assert.equal(notPdf.status, 415);
  assert.equal(notPdf.code, "PROOF_NOT_PDF");
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4 * 1024 * 1024 + 10, 0x20)]);
  assert.equal((await upload(c, big)).status, 413);
  assert.equal((await upload(c, PDF(), { method: "cash" })).status, 400, "only the approved methods");
  assert.equal((await call("POST", `${contractPath(c)}/payment-proofs?method=bank_transfer&reference=x`, c.owner.token, PDF(), { "content-type": "image/png" })).status, 400, "the body must be application/pdf");
  const staff = await memberOf(c.orgId, "STAFF");
  assert.equal((await upload(c, PDF(), {}, staff.token)).status, 403);
  const other = await pendingContract();
  assert.equal((await call("POST", `/organizations/${other.orgId}/contracts/${c.contractId}/payment-proofs?method=bank_transfer&reference=x`, other.owner.token, PDF(), { "content-type": "application/pdf" })).status, 404);
  const file = PDF("same");
  const first = await upload(c, file);
  assert.equal(first.status, 201, first.raw);
  assert.equal(first.data.proof.status, "submitted");
  assert.equal(first.data.proof.fileName, "talão.pdf");
  assert.equal(first.data.proof.sha256, sha(file));
  const again = await upload(c, file);
  assert.equal(again.status, 200);
  assert.equal(again.data.proof.id, first.data.proof.id);
  const detail = await call("GET", contractPath(c), c.owner.token);
  assert.equal(detail.data.proofs.length, 1);
  assert.equal(detail.data.proofs[0].uploadedByUserId, undefined, "the client view carries no internal actor ids");
  // Abuse bound: at most 5 waiting for review.
  for (let i = 0; i < 4; i++) assert.equal((await upload(c, PDF())).status, 201);
  assert.equal((await upload(c, PDF())).code, "TOO_MANY_PROOFS");
});

test("proof review: UL is notified; the admin opens the PDF (audited) or rejects it with a reason the owner is emailed", async () => {
  const savedNotify = env.PAYMENTS_NOTIFY_EMAIL;
  env.PAYMENTS_NOTIFY_EMAIL = "financeiro-teste@ultimalinha.ao";
  try {
    const c = await pendingContract();
    const file = PDF();
    const up = await upload(c, file);
    const proofId = up.data.proof.id as string;
    const ops = (await outboxFor("commercial.payment_proof.submitted", "financeiro-teste@ultimalinha.ao")).filter((m) => m.dedupeKey.endsWith(proofId));
    assert.equal(ops.length, 1);
    assert.ok(!ops[0]!.bodyText.includes(c.owner.user.email), "the ops email carries no client personal data");
    const queue = await call("GET", "/platform/payment-proofs", admin.token);
    assert.ok(queue.data.some((p: { id: string }) => p.id === proofId));
    assert.equal((await call("GET", `/platform/payment-proofs/${proofId}/file`, noProofReader.token)).status, 403, "reading a proof is its own permission");
    const dl = await call("GET", `/platform/payment-proofs/${proofId}/file`, admin.token);
    assert.equal(dl.status, 200);
    assert.ok(dl.bytes!.equals(file));
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment;/);
    const [audit] = await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "platform.commercial.payment_proof.read"), eq(auditLogs.targetId, proofId)));
    assert.equal(audit!.n, 1);
    assert.equal((await call("POST", `/platform/payment-proofs/${proofId}/rejection`, admin.token, { reason: "" })).status, 400);
    const rej = await call("POST", `/platform/payment-proofs/${proofId}/rejection`, admin.token, { reason: "O valor do talão não corresponde ao contrato." });
    assert.equal(rej.status, 200, rej.raw);
    assert.equal(rej.data.status, "rejected");
    const mail = await outboxFor("commercial.payment_proof.rejected", c.owner.user.email);
    assert.equal(mail.length, 1);
    assert.match(mail[0]!.bodyText, /não corresponde ao contrato/);
    const detail = await call("GET", contractPath(c), c.owner.token);
    assert.equal(detail.data.proofs[0].rejectionReason, "O valor do talão não corresponde ao contrato.");
    // Accepting a rejected proof is refused — and refuses the whole confirmation (nothing recorded).
    const conf = await manual(c.contractId, paid({ proofId }));
    assert.equal(conf.code, "PROOF_NOT_SUBMITTED");
    const [n] = await db.select({ n: count() }).from(commercialPayments).where(eq(commercialPayments.contractId, c.contractId));
    assert.equal(n!.n, 0);
  } finally {
    env.PAYMENTS_NOTIFY_EMAIL = savedNotify;
  }
});

test("confirming with the proof the admin relied on accepts it in the same transaction; another contract's proof is refused", async () => {
  const c = await pendingContract();
  const up = await upload(c, PDF());
  const other = await pendingContract();
  const otherProof = (await upload(other, PDF())).data.proof.id as string;
  const mismatch = await manual(c.contractId, paid({ proofId: otherProof }));
  assert.equal(mismatch.code, "PROOF_MISMATCH");
  assert.equal((await db.select().from(commercialPayments).where(eq(commercialPayments.contractId, c.contractId))).length, 0, "rolled back");
  const ok1 = await manual(c.contractId, paid({ proofId: up.data.proof.id }), admin.token);
  assert.equal(ok1.status, 201, ok1.raw);
  assert.equal(ok1.data.activation.activated, true);
  const [proof] = await db.select().from(paymentProofs).where(eq(paymentProofs.id, up.data.proof.id));
  assert.equal(proof!.status, "accepted");
  assert.equal(proof!.reviewedByUserId, admin.user.id);
  // Paid: nothing more to upload for the first period.
  assert.equal((await upload(c, PDF())).code, "NOTHING_TO_PAY");
});

test("renewal proof: instructions and upload target the renewal awaiting payment", async () => {
  const c = await activeContract();
  await authorize(c);
  await endsIn(c.contractId, 3);
  await prepareDueRenewals();
  const [r] = await renewalsOf(c.contractId);
  const ins = await call("GET", `${contractPath(c)}/payment-instructions?renewalId=${r!.id}`, c.owner.token);
  assert.equal(ins.data.target.kind, "renewal");
  assert.match(ins.data.target.reference, /-R1$/);
  assert.equal(ins.data.target.dueAt, r!.periodStartsAt.toISOString());
  const up = await upload(c, PDF(), { renewalId: r!.id, method: "multicaixa_express", reference: "MCX-123" });
  assert.equal(up.status, 201, up.raw);
  assert.equal(up.data.proof.renewalId, r!.id);
  const ok1 = await manual(c.contractId, paid({ renewalId: r!.id, proofId: up.data.proof.id, method: "multicaixa_express" }));
  assert.equal(ok1.status, 201, ok1.raw);
  assert.equal((await renewalsOf(c.contractId))[0]!.status, "active");
});

test("database guards: proofs are reviewed once and their files never change", async () => {
  const c = await pendingContract();
  const up = await upload(c, PDF());
  const id = up.data.proof.id as string;
  await rejectsWith(() => db.execute(sql`update payment_proofs set sha256 = ${"a".repeat(64)} where id = ${id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`update payment_proof_files set content = 'x' where proof_id = ${id}`), /immutable/);
  await rejectsWith(() => db.execute(sql`delete from payment_proofs where id = ${id}`), /immutable/);
  await db.execute(sql`update payment_proofs set status = 'rejected', rejection_reason = 'x', reviewed_by_user_id = ${admin.user.id}, reviewed_at = now() where id = ${id}`);
  await rejectsWith(() => db.execute(sql`update payment_proofs set status = 'accepted', rejection_reason = null where id = ${id}`), /immutable/);
});

// ============================================================================ step 4 — failures and concurrency

test("concurrency — a manual confirmation and an integration confirmation of the same contract at once: one payment, one grant", async () => {
  const c = await pendingContract();
  const [a, b] = await Promise.all([
    manual(c.contractId, paid()),
    call("POST", "/service/payments/confirmations", michaToken, { contractId: c.contractId, amountMinor: "2500000", currency: "AOA", externalReference: `MX-${randomUUID()}`, receivedAt: new Date().toISOString() }, { "idempotency-key": `mx-${randomUUID()}` }),
  ]);
  assert.equal([a, b].filter((x) => x.status === 201).length, 1, `${a.status}:${a.code} ${b.status}:${b.code}`);
  assert.equal([a, b].filter((x) => x.code === "PAYMENT_ALREADY_CONFIRMED").length, 1);
  assert.equal((await db.select().from(commercialPayments).where(eq(commercialPayments.contractId, c.contractId))).length, 1);
  const [g] = await db.select({ n: count() }).from(entitlementGrants).where(and(eq(entitlementGrants.contractId, c.contractId), eq(entitlementGrants.status, "active")));
  assert.equal(g!.n, 1);
});

test("retries — the same request sent several times at once (same key, same body): one payment, every answer 2xx", async () => {
  const c = await pendingContract();
  const body = paid();
  const key = `pay-${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 5 }, () => manual(c.contractId, body, admin.token, key)));
  assert.ok(results.every((x) => x.status === 201 || x.status === 200 || x.code === "PAYMENT_ALREADY_CONFIRMED" || x.status === 409), results.map((x) => `${x.status}:${x.code}`).join(","));
  assert.equal(results.filter((x) => x.status === 201).length, 1);
  assert.equal((await db.select().from(commercialPayments).where(eq(commercialPayments.contractId, c.contractId))).length, 1);
  // After the race, a retry with the same key is a clean replay.
  const replay = await manual(c.contractId, body, admin.token, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
});

test("failure — a payment reference already used for another contract cannot confirm a second one (even concurrently)", async () => {
  const a = await pendingContract();
  const b = await pendingContract();
  const ref = `TRF-SHARED-${randomUUID()}`;
  const [x, y] = await Promise.all([manual(a.contractId, paid({ externalReference: ref })), manual(b.contractId, paid({ externalReference: ref }))]);
  assert.equal([x, y].filter((r) => r.status === 201).length, 1, `${x.status}:${x.code} ${y.status}:${y.code}`);
  const [n] = await db.select({ n: count() }).from(commercialPayments).where(eq(commercialPayments.externalReference, ref));
  assert.equal(n!.n, 1);
});
