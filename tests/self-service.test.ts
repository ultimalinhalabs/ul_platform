import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, count, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  applications,
  contractItems,
  contracts,
  entitlementGrants,
  memberships,
  organizations,
  plans,
  platformMemberships,
  platformRoles,
  proposalItems,
  proposalOptions,
  proposals,
  roles,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createPlatformApiKey } from "../src/modules/apiKeys/service.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser } from "./helpers.js";

/**
 * Migration 0024 — self-service contracting on the same commercial infrastructure:
 * catalog → generated frozen offer (proposal channel self_service) → existing acceptance → contract →
 * payment confirmation → the one activation path. The values configured here are TEST values only;
 * the real catalog values are UL's decision. NA_PISTA/STARTER is configured for the run and restored
 * afterwards (other suites assert the seeded catalog).
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies vary per assertion
type Res = { status: number; data: any; code?: string; raw: string };

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
let admin: { user: { id: string; email: string }; token: string };
let approvedTermsId: string;
let draftTermsId: string;
let michaToken: string;
let starterBefore: typeof plans.$inferSelect;

const TEST_PRICE = "2500000"; // test value (25 000,00 AOA in minor units) — not an approved price
const TEST_PERIOD_DAYS = 30;

async function person(prefix: string, verified = true) {
  const user = await createTestUser(`ss-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, ${verified ? sql`now()` : null})`);
  return { user, token: await tokenFor(user) };
}
async function ownerWithOrg(prefix = "owner") {
  const owner = await person(prefix);
  const org = await createTestOrganization("ss-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  return { owner, orgId: org.id };
}
const configure = (body: Record<string, unknown>, token = admin.token) => call("PUT", "/platform/plans/NA_PISTA/STARTER/commercial", token, body);
const selfService = { purchaseMode: "self_service", priceMinor: TEST_PRICE, currency: "AOA", periodDays: TEST_PERIOD_DAYS };
const start = (orgId: string, token: string, body: Record<string, unknown> = { applicationKey: "NA_PISTA", planKey: "STARTER", client: { taxId: "5000000000", address: "Luanda, Rua de Teste 1" } }, key = `ss-${randomUUID()}`) =>
  call("POST", `/organizations/${orgId}/self-service/contracts`, token, body, { "idempotency-key": key });
const accept = (token: string, offer: { proposalId: string; versionId: string; optionId: string; contentSha256: string }) =>
  call("POST", `/proposals/${offer.proposalId}/acceptance`, token, { versionId: offer.versionId, optionId: offer.optionId, contentSha256: offer.contentSha256, signerName: "Ana Representante", consent: true }, { "idempotency-key": `acc-${randomUUID()}` });

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  const a = await person("platform-admin");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: a.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  platformUsers.push(a.user.id);
  admin = a;
  const body = `Termos de TESTE self-service ${randomUUID()}`;
  approvedTermsId = (await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`ss-${randomUUID().slice(0, 8)}`}, 1, 'Termos padrão (teste)', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`))[0]!.id;
  const draft = `Rascunho ${randomUUID()}`;
  draftTermsId = (await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, created_by)
    values (${`ss-draft-${randomUUID().slice(0, 8)}`}, 1, 'Rascunho', ${draft}, ${sha(draft)}, 'draft', ${admin.user.id}) returning id`))[0]!.id;
  [starterBefore] = await db.select().from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "NA_PISTA"), eq(plans.key, "STARTER"))).then((r) => r.map((x) => x.plans));
  const res = await configure({ ...selfService, termsTemplateId: approvedTermsId });
  assert.equal(res.status, 200, res.raw);
  michaToken = (await createPlatformApiKey({ applicationKey: "MICHA_EXPRESS", actorUserId: admin.user.id, scopes: ["payment.confirm"] })).secret;
});

after(async () => {
  server.close();
  // Restore the seeded catalog row exactly (contracts keep their frozen copy; plan rows are never deleted).
  await db.update(plans).set({ purchaseMode: starterBefore.purchaseMode, priceMinor: starterBefore.priceMinor, currency: starterBefore.currency, periodDays: starterBefore.periodDays, termsTemplateId: starterBefore.termsTemplateId }).where(eq(plans.id, starterBefore.id));
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

test("catalog: a self-service plan is listed with price, currency, period, entitlements and terms — payment always required", async () => {
  const { owner } = await ownerWithOrg();
  const res = await call("GET", "/catalog/self-service?applicationKey=NA_PISTA", owner.token);
  assert.equal(res.status, 200, res.raw);
  const starter = res.data.find((p: { planKey: string }) => p.planKey === "STARTER");
  assert.ok(starter);
  assert.equal(starter.priceMinor, TEST_PRICE);
  assert.equal(starter.currency, "AOA");
  assert.equal(starter.periodDays, TEST_PERIOD_DAYS);
  assert.equal(starter.paymentRequired, true);
  assert.equal(starter.terms.status, "approved");
  assert.equal(starter.contractable, true);
  assert.ok(Array.isArray(starter.entitlements) && starter.entitlements.length > 0);
  assert.ok(!res.data.some((p: { planKey: string }) => p.planKey === "BUSINESS"), "contractual plans are not in the self-service catalog");
  assert.equal((await call("GET", "/catalog/self-service")).status, 401);
});

test("catalog configuration: only a platform admin with platform.proposal.manage; a self-service plan needs every commercial value", async () => {
  const { owner } = await ownerWithOrg();
  assert.equal((await configure({ ...selfService, termsTemplateId: approvedTermsId }, owner.token)).status, 403);
  assert.equal((await configure({ ...selfService, priceMinor: null, termsTemplateId: approvedTermsId })).status, 400);
  assert.equal((await configure({ ...selfService, termsTemplateId: randomUUID() })).status, 404);
});

test("T01 (self-service + integration) — offer from the catalog, acceptance, payment confirmed by MICHA_EXPRESS, activation: access for 30 days", async () => {
  const { owner, orgId } = await ownerWithOrg();
  const offer = await start(orgId, owner.token);
  assert.equal(offer.status, 201, offer.raw);
  assert.equal(offer.data.priceMinor, TEST_PRICE);
  assert.equal(offer.data.periodDays, TEST_PERIOD_DAYS);
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, offer.data.proposalId));
  assert.equal(proposal!.channel, "self_service");
  assert.equal(proposal!.status, "sent");
  assert.equal(proposal!.organizationId, orgId);
  const [item] = await db.select({ item: proposalItems }).from(proposalItems).innerJoin(proposalOptions, eq(proposalOptions.id, proposalItems.optionId)).where(eq(proposalOptions.id, offer.data.optionId));
  assert.equal(item!.item.unitPriceMinor.toString(), TEST_PRICE);
  assert.equal(item!.item.durationDays, TEST_PERIOD_DAYS);
  assert.equal(item!.item.durationMonths, null);

  // The client sees the generated offer through the existing proposal view, and accepts it there.
  const view = await call("GET", `/proposals/${offer.data.proposalId}`, owner.token);
  assert.equal(view.status, 200, view.raw);
  assert.equal(view.data.options[0].items[0].durationDays, TEST_PERIOD_DAYS);
  const acc = await accept(owner.token, offer.data);
  assert.equal(acc.status, 201, acc.raw);
  const contractId = acc.data.contract.id as string;
  const [ci] = await db.select().from(contractItems).where(eq(contractItems.sourceProposalItemId, item!.item.id));
  assert.equal(ci!.durationDays, TEST_PERIOD_DAYS, "the period is frozen into the contract");

  const blocked = await call("POST", `/platform/contracts/${contractId}/activation`, admin.token);
  assert.equal(blocked.code, "PAYMENT_NOT_CONFIRMED", "acceptance alone never activates a paid package");

  const pay = await call("POST", "/service/payments/confirmations", michaToken, { contractId, amountMinor: TEST_PRICE, currency: "AOA", externalReference: `MX-${randomUUID()}`, receivedAt: new Date().toISOString() }, { "idempotency-key": `mx-${randomUUID()}` });
  assert.equal(pay.status, 201, pay.raw);
  assert.equal(pay.data.activation.activated, true);
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  assert.equal(c!.status, "active");
  assert.equal(c!.endsAt!.getTime() - c!.startsAt!.getTime(), TEST_PERIOD_DAYS * 86_400_000);
  const me = await call("GET", "/me", owner.token);
  assert.ok(me.data.memberships.find((m: { organizationId: string }) => m.organizationId === orgId).applications.some((a: { key: string }) => a.key === "NA_PISTA"));
});

test("T17 — the same Idempotency-Key returns the same contracting; reused for another plan it is a 409", async () => {
  const { owner, orgId } = await ownerWithOrg();
  const key = `ss-${randomUUID()}`;
  const first = await start(orgId, owner.token, undefined, key);
  assert.equal(first.status, 201);
  const again = await start(orgId, owner.token, undefined, key);
  assert.equal(again.status, 200);
  assert.equal(again.data.proposalId, first.data.proposalId);
  assert.equal(again.data.contentSha256, first.data.contentSha256);
  assert.equal((await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "BUSINESS", client: { taxId: "5000000000", address: "Luanda, Rua de Teste 1" } }, key)).status, 409);
  const raced = await Promise.all(Array.from({ length: 4 }, () => start(orgId, owner.token, undefined, `ss-race-${key}`)));
  assert.equal(new Set(raced.map((r) => r.data.proposalId)).size, 1, raced.map((r) => r.status).join(","));
});

test("T15 — the client cannot set price, period or limits: extra fields are refused and the catalog is the only source", async () => {
  const { owner, orgId } = await ownerWithOrg();
  assert.equal((await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "STARTER", client: { taxId: "5000000000", address: "Luanda, Rua de Teste 1" }, priceMinor: "1" })).status, 400);
  assert.equal((await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "STARTER", client: { taxId: "5000000000", address: "Luanda, Rua de Teste 1" }, periodDays: 365 })).status, 400);
  const offer = await start(orgId, owner.token);
  // A later catalog change never alters an accepted contract (frozen copy).
  const acc = await accept(owner.token, offer.data);
  assert.equal(acc.status, 201, acc.raw);
  assert.equal((await configure({ ...selfService, priceMinor: "9999999", termsTemplateId: approvedTermsId })).status, 200);
  const [c] = await db.select().from(contracts).where(eq(contracts.id, acc.data.contract.id));
  assert.equal(c!.totalMinor.toString(), TEST_PRICE);
  assert.equal((await configure({ ...selfService, termsTemplateId: approvedTermsId })).status, 200);
  const pay = await call("POST", `/platform/contracts/${c!.id}/payments`, admin.token, { amountMinor: "9999999", currency: "AOA", method: "bank_transfer", externalReference: `TRF-${randomUUID()}`, receivedAt: new Date().toISOString(), evidenceReference: "REC-0001" }, { "idempotency-key": `p-${randomUUID()}` });
  assert.equal(pay.code, "PAYMENT_AMOUNT_MISMATCH", "the payment must match the contract, not the current catalog");
});

test("T04 — a plan whose terms are a draft is listed as not contractable and cannot be contracted", async () => {
  const { owner, orgId } = await ownerWithOrg();
  assert.equal((await configure({ ...selfService, termsTemplateId: draftTermsId })).status, 200);
  try {
    const listed = (await call("GET", "/catalog/self-service?applicationKey=NA_PISTA", owner.token)).data.find((p: { planKey: string }) => p.planKey === "STARTER");
    assert.equal(listed.contractable, false);
    const res = await start(orgId, owner.token);
    assert.equal(res.status, 409);
    assert.equal(res.code, "TERMS_NOT_APPROVED");
    const [n] = await db.select({ n: count() }).from(proposals).where(eq(proposals.organizationId, orgId));
    assert.equal(n!.n, 0);
  } finally {
    await configure({ ...selfService, termsTemplateId: approvedTermsId });
  }
});

test("who may contract: OWNER of an active organization with a verified email — never STAFF, unverified, suspended, non-members or platform admins", async () => {
  const { owner, orgId } = await ownerWithOrg();
  const staff = await person("staff");
  const [staffRole] = await db.select().from(roles).where(eq(roles.key, "STAFF"));
  await db.insert(memberships).values({ userId: staff.user.id, organizationId: orgId, roleId: staffRole!.id, status: "active" });
  assert.equal((await start(orgId, staff.token)).status, 403, "STAFF");
  const outsider = await person("outsider");
  assert.ok([403, 404].includes((await start(orgId, outsider.token)).status), "not a member");
  const unverified = await person("unverified", false);
  const org2 = await createTestOrganization("ss-org-unverified", unverified.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: unverified.user.id, organizationId: org2.id, roleId: ownerRole!.id, status: "active" });
  const u = await start(org2.id, unverified.token);
  assert.equal(u.status, 403);
  assert.equal(u.code, "EMAIL_NOT_VERIFIED");
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgId));
  assert.equal((await start(orgId, owner.token)).status, 403, "suspended organization");
  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgId));
  await db.insert(memberships).values({ userId: admin.user.id, organizationId: orgId, roleId: ownerRole!.id, status: "active" });
  assert.equal((await start(orgId, admin.token)).status, 403, "a platform admin cannot contract on behalf of a client");
  assert.equal((await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "BUSINESS", client: { taxId: "5000000000", address: "Luanda, Rua de Teste 1" } })).status, 404, "a contractual plan is not self-service");
  assert.equal((await start(orgId, owner.token, undefined, "short")).status, 400, "Idempotency-Key required");
});

test("an organization that already subscribes to the application cannot start a second contracting (SUBSCRIPTION_CONFLICT)", async () => {
  const { owner, orgId } = await ownerWithOrg();
  await createSubscription({ organizationId: orgId, applicationKey: "NA_PISTA", planKey: "BUSINESS", actorUserId: admin.user.id });
  const res = await start(orgId, owner.token);
  assert.equal(res.status, 409);
  assert.equal(res.code, "SUBSCRIPTION_CONFLICT");
});

test("T03 — an offer that was never accepted has no contract: nothing can be paid or activated", async () => {
  const { owner, orgId } = await ownerWithOrg();
  const offer = await start(orgId, owner.token);
  assert.equal(offer.status, 201);
  const [n] = await db.select({ n: count() }).from(contracts).where(eq(contracts.organizationId, orgId));
  assert.equal(n!.n, 0);
  const [g] = await db.select({ n: count() }).from(entitlementGrants).where(eq(entitlementGrants.organizationId, orgId));
  assert.equal(g!.n, 0);
});

test("2.1 — self-service requires the client's NIF and registered address; they are frozen in the offer", async () => {
  assert.equal((await configure({ ...selfService, termsTemplateId: approvedTermsId })).status, 200);
  const { owner, orgId } = await ownerWithOrg("legal-ss");
  const noClient = await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "STARTER" });
  assert.equal(noClient.status, 400, "client data is mandatory");
  const noAddress = await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "STARTER", client: { taxId: "5000000000" } });
  assert.equal(noAddress.status, 400);
  const ok = await start(orgId, owner.token, { applicationKey: "NA_PISTA", planKey: "STARTER", client: { legalName: "Loja Legal, Lda", taxId: "5009999999", address: "Luanda, Talatona", licenseNumber: "ALV-77" } });
  assert.equal(ok.status, 201, ok.raw);
  const view = await call("GET", `/proposals/${ok.data.proposalId}`, owner.token);
  assert.equal(view.data.proposal.prospectCompanyName, "Loja Legal, Lda");
  assert.equal(view.data.proposal.prospectTaxId, "5009999999");
});
