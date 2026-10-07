import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  applications,
  auditLogs,
  commercialEvents,
  contractItems,
  contracts,
  contractVersions,
  entitlementGrants,
  memberships,
  organizations,
  platformMemberships,
  platformRoles,
  plans,
  proposalAcceptances,
  proposals,
  proposalVersions,
  roles,
  users,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { canonicalSha256 } from "../src/modules/commercial/canonicalJson.js";
import { currentAcceptanceConsent } from "../src/modules/commercial/consent.js";
import { PLATFORM_LEGAL_IDENTITY_V1 } from "../src/modules/commercial/legalIdentity.js";
import { createTestOrganization, createTestUser } from "./helpers.js";

/**
 * Block 1C — acceptance + contract, end to end over HTTP against the
 * disposable test database (guarded). JWTs signed locally with the TEST
 * secret; a minimal `auth.users` provides email verification as in a
 * Supabase project. No network beyond the local server, no real credentials,
 * no production. Commercial history created here is immutable by design and
 * stays in the disposable database; the test platform admin's membership is
 * removed afterwards (other suites assume no active admin).
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();

type User = { id: string; email: string };
/** Parsed JSON (bodies and stored snapshots) is read freely by the assertions — the type JSON.parse returns. */
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
async function person(prefix: string, opts: { verified?: boolean } = {}) {
  const user = await createTestUser(`b1c-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, ${opts.verified === false ? null : sql`now()`})`);
  return { user, token: await tokenFor(user) };
}

async function addMember(userId: string, organizationId: string, roleKey: string) {
  const [role] = await db.select().from(roles).where(eq(roles.key, roleKey));
  await db.insert(memberships).values({ userId, organizationId, roleId: role!.id, status: "active" });
}

async function orgOwnedBy(userId: string, prefix = "b1c-org") {
  const org = await createTestOrganization(prefix, userId);
  await addMember(userId, org.id, "OWNER");
  return org.id;
}

let admin: { user: User; token: string };
let termsId: string;
let termsBody: string;

/** A SENT proposal (two options: "Essencial" recommended + "Advanced"), addressed to `recipientEmail`. */
async function sentProposal(recipientEmail: string, organizationId: string | null, opts: { validUntil?: string; extraItem?: Record<string, unknown> } = {}) {
  const created = await call("POST", "/platform/proposals", admin.token, {
    prospectCompanyName: "Cliente de Teste",
    prospectTaxId: "000000000",
    recipientName: "Destinatário",
    recipientEmail,
    organizationId,
    validUntil: opts.validUntil ?? future(),
    summary: "Resumo",
    termsTemplateId: termsId,
  });
  assert.equal(created.status, 201, created.raw);
  const proposalId = created.data.id as string;
  const versionId = created.data.versions[0].id as string;
  const v = `/platform/proposals/${proposalId}/versions/${versionId}`;
  const o1 = await call("POST", `${v}/options`, admin.token, { name: "Essencial", isRecommended: true, sort: 0 });
  const essencialId = o1.data.options[0].id as string;
  await call("POST", `${v}/options/${essencialId}/items`, admin.token, { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "20000000", billingPeriod: "monthly", durationMonths: 1, entitlementSpec: { seats: 3 } });
  await call("POST", `${v}/options/${essencialId}/items`, admin.token, { kind: "support", title: "Suporte remoto", quantity: 2, unitPriceMinor: "1500000", sort: 1 });
  if (opts.extraItem) await call("POST", `${v}/options/${essencialId}/items`, admin.token, opts.extraItem);
  const o2 = await call("POST", `${v}/options`, admin.token, { name: "Advanced", sort: 1 });
  const advancedId = o2.data.options[1].id as string;
  await call("POST", `${v}/options/${advancedId}/items`, admin.token, { kind: "service", title: "Dashboard personalizada", quantity: 1, unitPriceMinor: "35000000" });
  const sent = await call("POST", `${v}/send`, admin.token);
  assert.equal(sent.status, 200, sent.raw);
  return { proposalId, versionId, essencialId, advancedId, contentSha256: sent.data.contentSha256 as string };
}

const accept = (token: string | undefined, p: { proposalId: string; versionId: string; contentSha256: string }, optionId: string, extra: Record<string, unknown> = {}, key = `k-${randomUUID()}`) =>
  call("POST", `/proposals/${p.proposalId}/acceptance`, token, { versionId: p.versionId, optionId, contentSha256: p.contentSha256, signerName: "Ana Signatária", signerTitle: "Directora", consent: true, ...extra }, { "idempotency-key": key, "user-agent": "b1c-test-agent/1.0" });

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  const adminUser = await createTestUser("b1c-platform-admin");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: adminUser.id, platformRoleId: role!.id, status: "ACTIVE" });
  admin = { user: adminUser, token: await tokenFor(adminUser) };
  termsBody = `Termos de TESTE ${randomUUID()} — não jurídicos.`;
  const rows = await db.execute<{ id: string }>(sql`
    insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`b1c-${randomUUID().slice(0, 8)}`}, 1, 'Termos de teste', ${termsBody}, ${sha(termsBody)}, 'approved', ${adminUser.id}, now(), ${adminUser.id}) returning id`);
  termsId = rows[0]!.id;
});

after(async () => {
  server.close();
  if (admin) await db.delete(platformMemberships).where(eq(platformMemberships.userId, admin.user.id));
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

test("consent: test-only text is refused outside development/test (production and staging fail closed)", () => {
  assert.equal(currentAcceptanceConsent({ nodeEnv: "production", appEnv: "production" }).available, false);
  assert.equal(currentAcceptanceConsent({ nodeEnv: "production", appEnv: "development" }).available, false);
  assert.equal(currentAcceptanceConsent({ nodeEnv: "test", appEnv: "staging" }).available, false);
  const t = currentAcceptanceConsent({ nodeEnv: "test", appEnv: "development" });
  assert.equal(t.available, true);
  if (t.available) {
    assert.equal(t.consent.status, "test_only");
    assert.match(t.consent.text, /^TEST ONLY — NÃO UTILIZAR EM PRODUÇÃO/);
    assert.equal(t.sha256, sha(t.consent.text));
  }
});

test("valid acceptance by the verified recipient OWNER: 201, contract pending_activation with v1 and the chosen items; nothing activated", async () => {
  const r = await person("owner");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);

  const mine = await call("GET", "/me/proposals", r.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((x: { id: string }) => x.id === p.proposalId));
  const view = await call("GET", `/proposals/${p.proposalId}`, r.token);
  assert.equal(view.status, 200);
  assert.equal(view.data.version.contentSha256, p.contentSha256);
  assert.equal(view.data.acceptable, true);
  assert.deepEqual(view.data.options.map((o: { id: string }) => o.id), [p.essencialId, p.advancedId]);

  const res = await accept(r.token, p, p.essencialId);
  assert.equal(res.status, 201, res.raw);
  const { acceptance, contract } = res.data;
  assert.equal(acceptance.versionId, p.versionId);
  assert.equal(acceptance.optionId, p.essencialId);
  assert.equal(acceptance.contentSha256, p.contentSha256);
  assert.equal(acceptance.organizationId, orgId);
  assert.equal(acceptance.signerEmail, r.user.email);
  assert.match(contract.number, /^UL-C-\d{4}-\d{6,}$/);
  assert.equal(contract.status, "pending_activation");
  assert.equal(contract.totalMinor, "23000000");
  assert.equal(contract.currency, "AOA");
  assert.equal(contract.startsAt, null);
  assert.equal(contract.endsAt, null);
  assert.equal(new Date(contract.effectiveAt).getTime(), new Date(acceptance.acceptedAt).getTime());

  const [row] = await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.id, acceptance.id));
  assert.equal(row!.ip, null, "D3: no untrustworthy IP is recorded");
  assert.equal(row!.userAgent, "b1c-test-agent/1.0");
  assert.match(row!.consentText, /^TEST ONLY/);
  assert.equal(row!.consentSha256, sha(row!.consentText));
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, p.proposalId));
  assert.equal(proposal!.status, "accepted");
  assert.equal(proposal!.acceptedVersionId, p.versionId);

  const items = await db.select().from(contractItems).where(eq(contractItems.contractVersionId, contract.currentVersion.id));
  assert.deepEqual(items.map((i) => [i.title, i.unitPriceMinor.toString(), i.lineTotalMinor.toString()]).sort(), [["Na Pista Business", "20000000", "20000000"], ["Suporte remoto", "1500000", "3000000"]]);
  assert.equal(items.some((i) => i.title === "Dashboard personalizada"), false, "items of the option NOT chosen never enter the contract");

  const types = async (aggregateId: string) => (await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, aggregateId))).map((e) => e.t);
  assert.deepEqual(await types(acceptance.id), ["proposal.accepted"]);
  assert.deepEqual(await types(contract.id), ["contract.created"]);
  assert.deepEqual(await types(contract.currentVersion.id), ["contract.version.created"]);
  assert.equal((await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, acceptance.id), eq(auditLogs.action, "commercial.proposal.accepted")))).length, 1);

  assert.equal((await db.select().from(entitlementGrants).where(eq(entitlementGrants.organizationId, orgId))).length, 0, "D9: no grants in 1C");
  assert.equal(Number(((await db.execute(sql`select count(*)::int as n from subscriptions where organization_id = ${orgId}`))[0] as { n: number }).n), 0);
  assert.equal(Number(((await db.execute(sql`select count(*)::int as n from organization_application_access where organization_id = ${orgId}`))[0] as { n: number }).n), 0);

  const readBack = await call("GET", `/organizations/${orgId}/contracts/${contract.id}`, r.token);
  assert.equal(readBack.status, 200);
  assert.equal(readBack.data.snapshot.contract.number, contract.number);
});

test("exact photograph: content hash recomputes; source, parties (legal identity, no ID number), option, items, money and terms are preserved", async () => {
  const r = await person("snapshot");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  const res = await accept(r.token, p, p.essencialId);
  assert.equal(res.status, 201, res.raw);
  const [cv] = await db.select().from(contractVersions).where(eq(contractVersions.id, res.data.contract.currentVersion.id));
  const snap = cv!.snapshot as Json;
  assert.equal(canonicalSha256(snap), cv!.contentSha256);
  assert.equal(snap.schema, "ul.commercial.contract-version/1");
  assert.equal(snap.source.proposalVersionId, p.versionId);
  assert.equal(snap.source.proposalContentSha256, p.contentSha256);
  assert.equal(snap.source.acceptanceId, res.data.acceptance.id);
  assert.deepEqual(snap.parties.provider, PLATFORM_LEGAL_IDENTITY_V1);
  assert.equal(JSON.stringify(cv!.parties).toLowerCase().includes("bilhete"), false);
  assert.equal(snap.parties.client.organization.id, orgId);
  assert.equal(snap.parties.client.signer.email, r.user.email);
  assert.equal(snap.option.id, p.essencialId);
  assert.equal(snap.option.totalMinor, "23000000");
  const [pv] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, p.versionId));
  const proposalOption = (pv!.snapshot as Json).options.find((o: { id: string }) => o.id === p.essencialId);
  assert.deepEqual(snap.items, proposalOption.items, "items are the frozen option items, unchanged");
  assert.equal(snap.items[0].entitlementSpec.seats, 3);
  assert.equal(snap.terms.body, termsBody);
  assert.equal(snap.terms.bodySha256, sha(termsBody));
  assert.equal(cv!.termsSha256, sha(termsBody));
});

test("catalog changes after sending never change what is accepted (no rebuild from current applications/plans)", async () => {
  const r = await person("catalog");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  const [app0] = await db.select().from(applications).where(eq(applications.key, "NA_PISTA"));
  await db.update(applications).set({ name: "Na Pista (renomeado)" }).where(eq(applications.id, app0!.id));
  try {
    const res = await accept(r.token, p, p.essencialId);
    assert.equal(res.status, 201, res.raw);
    const [cv] = await db.select().from(contractVersions).where(eq(contractVersions.id, res.data.contract.currentVersion.id));
    const item = (cv!.snapshot as Json).items[0];
    assert.equal(item.application.name, app0!.name, "the contract keeps the name presented in the proposal");
    assert.equal(item.unitPriceMinor, "20000000");
  } finally {
    await db.update(applications).set({ name: app0!.name }).where(eq(applications.id, app0!.id));
  }
});

test("identity gates: no session 401, unverified 403, other email 404, link token alone 401, disabled 403, platform admin 403", async () => {
  const r = await person("gates");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  assert.equal((await accept(undefined, p, p.essencialId)).status, 401);

  const unverified = await person("unverified", { verified: false });
  const pu = await sentProposal(unverified.user.email, await orgOwnedBy(unverified.user.id));
  const u = await accept(unverified.token, pu, pu.essencialId);
  assert.equal(u.status, 403);
  assert.equal((await call("GET", "/me/proposals", unverified.token)).status, 403);

  const stranger = await person("stranger");
  await addMember(stranger.user.id, orgId, "OWNER");
  assert.equal((await accept(stranger.token, p, p.essencialId)).status, 404, "not the recipient: the proposal does not exist for them");
  assert.equal((await call("GET", `/proposals/${p.proposalId}`, stranger.token)).status, 404);

  const link = await call("POST", `/platform/proposals/${p.proposalId}/links`, admin.token, {});
  assert.equal((await accept(link.data.token, p, p.essencialId)).status, 401, "a link token is not a credential");
  const pub = await call("POST", "/public/proposals/resolve", undefined, { token: link.data.token });
  assert.deepEqual(pub.data.acceptance, { available: false });

  await db.update(users).set({ status: "disabled" }).where(eq(users.id, r.user.id));
  const disabled = await accept(r.token, p, p.essencialId);
  assert.equal(disabled.status, 403);
  assert.equal(disabled.code, "ACCOUNT_DISABLED");
  await db.update(users).set({ status: "active" }).where(eq(users.id, r.user.id));

  // A platform administrator who is even the recipient and OWNER never accepts (D2).
  const staff = await person("staff");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: staff.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  try {
    const ps = await sentProposal(staff.user.email, await orgOwnedBy(staff.user.id));
    assert.equal((await accept(staff.token, ps, ps.essencialId)).status, 403);
  } finally {
    await db.delete(platformMemberships).where(eq(platformMemberships.userId, staff.user.id));
  }
  assert.equal((await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, p.proposalId))).length, 0);
});

test("organization gates: no membership, STAFF/MANAGER/ADMIN refused; suspended organization refused; only an active OWNER accepts", async () => {
  const owner = await person("org-owner");
  const orgId = await orgOwnedBy(owner.user.id);
  for (const roleKey of [null, "STAFF", "MANAGER", "ADMIN"]) {
    const r = await person(`role-${roleKey ?? "none"}`);
    if (roleKey) await addMember(r.user.id, orgId, roleKey);
    const p = await sentProposal(r.user.email, orgId);
    const res = await accept(r.token, p, p.essencialId);
    assert.equal(res.status, 403, `${roleKey ?? "no membership"} must not accept`);
  }
  const suspendedOwner = await person("suspended-owner");
  const suspendedOrg = await orgOwnedBy(suspendedOwner.user.id);
  const ps = await sentProposal(suspendedOwner.user.email, suspendedOrg);
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, suspendedOrg));
  const s = await accept(suspendedOwner.token, ps, ps.essencialId);
  assert.equal(s.status, 403);
  assert.equal(s.code, "ORGANIZATION_SUSPENDED");
});

test("exact version: unknown 404, draft 409, superseded 409, withdrawn 409, expired 409, hash mismatch 409; any valid option may be chosen", async () => {
  const r = await person("versions");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  assert.equal((await accept(r.token, { ...p, versionId: randomUUID() }, p.essencialId)).status, 404);
  assert.equal((await accept(r.token, { ...p, contentSha256: sha("tampered") }, p.essencialId)).status, 409);

  const v2 = await call("POST", `/platform/proposals/${p.proposalId}/versions`, admin.token);
  assert.equal((await accept(r.token, { ...p, versionId: v2.data.id }, v2.data.options[0].id)).status, 409, "a draft is never acceptable");
  const sent2 = await call("POST", `/platform/proposals/${p.proposalId}/versions/${v2.data.id}/send`, admin.token);
  assert.equal((await accept(r.token, p, p.essencialId)).status, 409, "superseded v1");
  const p2 = { proposalId: p.proposalId, versionId: v2.data.id, contentSha256: sent2.data.contentSha256 };
  await db.update(proposalVersions).set({ status: "withdrawn" }).where(eq(proposalVersions.id, v2.data.id));
  assert.equal((await accept(r.token, p2, v2.data.options[1].id)).status, 409, "withdrawn");

  const validUntil = future(6000);
  const expiring = await sentProposal(r.user.email, orgId, { validUntil });
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(validUntil) - Date.now() + 300)));
  assert.equal((await accept(r.token, expiring, expiring.essencialId)).status, 409, "expired");

  const fresh = await sentProposal(r.user.email, orgId);
  const chosen = await accept(r.token, fresh, fresh.advancedId);
  assert.equal(chosen.status, 201, "the non-recommended option is a valid choice");
  assert.equal(chosen.data.contract.totalMinor, "35000000");
});

test("options: unknown option 404; option of another proposal 404", async () => {
  const r = await person("options");
  const orgId = await orgOwnedBy(r.user.id);
  const a = await sentProposal(r.user.email, orgId);
  const b = await sentProposal(r.user.email, orgId);
  assert.equal((await accept(r.token, a, randomUUID())).status, 404);
  assert.equal((await accept(r.token, a, b.essencialId)).status, 404);
});

test("idempotency: replay 200 with the same result; same key + different body 409; identical second acceptance 200; other option 409", async () => {
  const r = await person("idem");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  const key = `idem-${randomUUID()}`;
  const first = await accept(r.token, p, p.essencialId, {}, key);
  assert.equal(first.status, 201);
  const replay = await accept(r.token, p, p.essencialId, {}, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.acceptance.id, first.data.acceptance.id);
  assert.equal(replay.data.contract.id, first.data.contract.id);
  assert.equal((await accept(r.token, p, p.advancedId, {}, key)).status, 409, "same key, different body");
  assert.equal((await accept(r.token, p, p.essencialId)).status, 200, "identical acceptance with a new key");
  assert.equal((await accept(r.token, p, p.advancedId)).status, 409, "another option after acceptance");
  assert.equal((await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, p.proposalId))).length, 1);
  assert.equal((await db.select().from(contracts).where(eq(contracts.sourceAcceptanceId, first.data.acceptance.id))).length, 1);
  assert.equal((await call("POST", `/proposals/${p.proposalId}/acceptance`, r.token, { versionId: p.versionId, optionId: p.essencialId, contentSha256: p.contentSha256, signerName: "A", consent: true })).status, 400, "Idempotency-Key is mandatory");
});

test("concurrency: simultaneous acceptances produce exactly one acceptance and one contract", async () => {
  const r = await person("race");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  const results = await Promise.all([accept(r.token, p, p.essencialId), accept(r.token, p, p.essencialId), accept(r.token, p, p.advancedId)]);
  const statuses = results.map((x) => x.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
  assert.ok(statuses.every((s) => s === 201 || s === 200 || s === 409));
  const rows = await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, p.proposalId));
  assert.equal(rows.length, 1);
  assert.equal((await db.select().from(contracts).where(eq(contracts.sourceAcceptanceId, rows[0]!.id))).length, 1);
});

test("contract duplication is impossible at the database level", async () => {
  const r = await person("dup");
  const orgId = await orgOwnedBy(r.user.id);
  const p = await sentProposal(r.user.email, orgId);
  const res = await accept(r.token, p, p.essencialId);
  await assert.rejects(
    async () => {
      await db.insert(contracts).values({ number: `UL-C-2099-${String(Date.now()).slice(-6)}`, organizationId: orgId, sourceAcceptanceId: res.data.acceptance.id, currency: "AOA", totalMinor: 1n, effectiveAt: new Date() });
    },
    (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "23505",
  );
});

test("prospect: accept into an existing organization the user OWNS, or create one in the same act (user becomes OWNER)", async () => {
  const r = await person("prospect");
  const owned = await orgOwnedBy(r.user.id, "b1c-owned");
  const p1 = await sentProposal(r.user.email, null);
  const refused = await accept(r.token, p1, p1.essencialId);
  assert.equal(refused.status, 409, "an organization must be chosen or created");
  const elsewhere = await person("other-owner");
  const notMine = await orgOwnedBy(elsewhere.user.id);
  assert.equal((await accept(r.token, p1, p1.essencialId, { organization: { id: notMine } })).status, 403);
  const existing = await accept(r.token, p1, p1.essencialId, { organization: { id: owned } });
  assert.equal(existing.status, 201, existing.raw);
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, p1.proposalId));
  assert.equal(prop!.organizationId, owned);

  const p2 = await sentProposal(r.user.email, null);
  const name = `Nova Org ${randomBytes(3).toString("hex")}`;
  const created = await accept(r.token, p2, p2.essencialId, { organization: { create: { name } } });
  assert.equal(created.status, 201, created.raw);
  const newOrgId = created.data.acceptance.organizationId;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, newOrgId));
  assert.equal(org!.name, name);
  const [m] = await db.select({ roleKey: roles.key }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId)).where(and(eq(memberships.userId, r.user.id), eq(memberships.organizationId, newOrgId)));
  assert.equal(m!.roleKey, "OWNER");
  const proposalAddressedElsewhere = await sentProposal(r.user.email, owned);
  assert.equal((await accept(r.token, proposalAddressedElsewhere, proposalAddressedElsewhere.essencialId, { organization: { create: { name: "Outra" } } })).status, 409, "a proposal addressed to an organization cannot go to another one");
});

test("rollback: a failure after creating the organization leaves no organization, acceptance, contract or event behind", async () => {
  const r = await person("rollback");
  const p = await sentProposal(r.user.email, null);
  // Temporarily rename the KEY of the seeded NA_PISTA/BUSINESS plan so the item-by-item check fails AFTER the organization
  // is created inside the transaction; restored in `finally` (no permanent test rows: other suites count the catalog).
  const [business] = await db.select({ id: plans.id, key: plans.key }).from(plans).innerJoin(applications, eq(applications.id, plans.applicationId)).where(and(eq(applications.key, "NA_PISTA"), eq(plans.key, "BUSINESS")));
  const name = `Rollback Org ${randomBytes(3).toString("hex")}`;
  let res: Res;
  await db.update(plans).set({ key: "BUSINESS_B1C_TMP" }).where(eq(plans.id, business!.id));
  try {
    res = await accept(r.token, p, p.essencialId, { organization: { create: { name } } });
  } finally {
    await db.update(plans).set({ key: business!.key }).where(eq(plans.id, business!.id));
  }
  assert.equal(res.status, 409, res.raw);
  assert.equal((await db.select().from(organizations).where(eq(organizations.name, name))).length, 0, "organization creation rolled back");
  assert.equal((await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, p.proposalId))).length, 0);
  const [prop] = await db.select().from(proposals).where(eq(proposals.id, p.proposalId));
  assert.equal(prop!.status, "sent");
  assert.equal(prop!.organizationId, null);
  const accepted = await db.select().from(commercialEvents).where(and(eq(commercialEvents.eventType, "proposal.accepted"), sql`${commercialEvents.payload}->>'proposalId' = ${p.proposalId}`));
  assert.equal(accepted.length, 0);
});

test("tenant isolation of contracts: only an OWNER of THAT organization reads them", async () => {
  const a = await person("tenant-a");
  const orgA = await orgOwnedBy(a.user.id);
  const pa = await sentProposal(a.user.email, orgA);
  const acc = await accept(a.token, pa, pa.essencialId);
  const contractA = acc.data.contract.id as string;
  const b = await person("tenant-b");
  const orgB = await orgOwnedBy(b.user.id);
  const listB = await call("GET", `/organizations/${orgB}/contracts`, b.token);
  assert.equal(listB.status, 200);
  assert.equal(listB.raw.includes(contractA), false);
  assert.equal((await call("GET", `/organizations/${orgB}/contracts/${contractA}`, b.token)).status, 404, "another organization's contract is not found");
  assert.equal((await call("GET", `/organizations/${orgA}/contracts`, b.token)).status, 403, "not a member of A");
  const staff = await person("tenant-staff");
  await addMember(staff.user.id, orgA, "STAFF");
  assert.equal((await call("GET", `/organizations/${orgA}/contracts`, staff.token)).status, 403, "members other than OWNER cannot read contracts");
  const listA = await call("GET", `/organizations/${orgA}/contracts`, a.token);
  assert.equal(listA.status, 200);
  assert.ok(listA.raw.includes(contractA));
  assert.equal((await call("GET", `/platform/proposals/${pa.proposalId}`, a.token)).status, 403, "clients never reach the platform routes");
});
