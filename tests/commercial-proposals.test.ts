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
  auditLogs,
  commercialEvents,
  memberships,
  organizations,
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  proposalAccessLinks,
  proposalOptions,
  proposals,
  proposalVersions,
  roles,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey } from "../src/modules/apiKeys/service.js";
import { canonicalSha256 } from "../src/modules/commercial/canonicalJson.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * Block 1B — commercial proposal API end to end over HTTP against the
 * disposable test database (guard: src/db/testDatabaseGuard.ts). JWTs are
 * signed locally with the TEST secret; no network beyond the local server,
 * no real credentials. Commercial history is immutable by design, so the
 * proposals, versions, links and events created here stay in the disposable
 * database (unique, `.invalid` identities); only non-commercial fixtures
 * (test platform role) are removed.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let limitedRoleId: string | undefined;

type User = { id: string; email: string };
/** The parsed JSON body is read freely by the assertions (same type JSON.parse returns). */
type Res = { status: number; data: ReturnType<typeof JSON.parse>; code?: string; headers: Headers; raw: string };

async function tokenFor(user: User) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : null;
  return { status: res.status, data: json?.data, code: json?.error?.code, headers: res.headers, raw };
}

async function platformUser(roleKey: string) {
  const user = await createTestUser(`b1b-${roleKey.toLowerCase()}`);
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, roleKey));
  await db.insert(platformMemberships).values({ userId: user.id, platformRoleId: role!.id, status: "ACTIVE" });
  return { user, token: await tokenFor(user) };
}

async function approvedTerms(approver: string, status: "approved" | "draft" = "approved") {
  const body = `Texto de termos de TESTE ${randomUUID()} — não jurídico.`;
  const rows = await db.execute<{ id: string }>(sql`
    insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`b1b-${randomUUID().slice(0, 8)}`}, 1, 'Termos de teste', ${body}, ${sha(body)}, ${status},
      ${status === "approved" ? approver : null}, ${status === "approved" ? sql`now()` : null}, ${approver})
    returning id`);
  return rows[0]!.id;
}

const future = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

let admin: { user: User; token: string };
let readOnly: { user: User; token: string };
let owner: User;
let ownerToken: string;
let activeOrgId: string;
let suspendedOrgId: string;
let termsId: string;

/** A proposal with one draft version, one recommended option and one application_plan item; ready to send. */
async function readyProposal(overrides: Record<string, unknown> = {}) {
  const created = await call("POST", "/platform/proposals", admin.token, {
    prospectCompanyName: "Empresa de Teste",
    recipientName: "Destinatário Teste",
    recipientEmail: `b1b+${randomUUID()}@test.ul-platform.invalid`,
    organizationId: activeOrgId,
    validUntil: future(),
    summary: "Proposta de teste",
    notes: "nota interna — não vai para o cliente",
    termsTemplateId: termsId,
    ...overrides,
  });
  assert.equal(created.status, 201, created.raw);
  const proposalId = created.data.id as string;
  const versionId = created.data.versions[0].id as string;
  const withOption = await call("POST", `/platform/proposals/${proposalId}/versions/${versionId}/options`, admin.token, { name: "Essencial", isRecommended: true });
  const optionId = withOption.data.options[0].id as string;
  const withItem = await call("POST", `/platform/proposals/${proposalId}/versions/${versionId}/options/${optionId}/items`, admin.token, {
    kind: "application_plan",
    title: "Na Pista Business — 1 mês",
    applicationKey: "NA_PISTA",
    planKey: "BUSINESS",
    quantity: 1,
    unitPriceMinor: "20000000",
    billingPeriod: "monthly",
    durationMonths: 1,
  });
  assert.equal(withItem.status, 201, withItem.raw);
  return { proposalId, versionId, optionId, itemId: withItem.data.options[0].items[0].id as string };
}

async function sendReady() {
  const p = await readyProposal();
  const sent = await call("POST", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/send`, admin.token);
  assert.equal(sent.status, 200, sent.raw);
  return { ...p, sent };
}

before(async () => {
  await seed();
  admin = await platformUser("PLATFORM_ADMIN");
  // A test-only platform role holding just platform.commercial.read (removed in `after`).
  const [role] = await db.insert(platformRoles).values({ key: `TEST_COMMERCIAL_READ_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test read-only" }).returning();
  limitedRoleId = role!.id;
  const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, "platform.commercial.read"));
  await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  readOnly = await platformUser(role!.key);
  owner = await createTestUser("b1b-org-owner");
  ownerToken = await tokenFor(owner);
  const org = await createTestOrganization("b1b-active", owner.id);
  activeOrgId = org.id;
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const suspended = await createTestOrganization("b1b-suspended", owner.id);
  suspendedOrgId = suspended.id;
  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, suspended.id));
  termsId = await approvedTerms(admin.user.id);
});

after(async () => {
  server.close();
  // The test platform admin must not stay ACTIVE: other suites (platform-administration bootstrap) assume no admin exists.
  // Its user row stays (commercial history RESTRICTs it), but a platform membership is not commercial history.
  if (admin) await db.delete(platformMemberships).where(eq(platformMemberships.userId, admin.user.id));
  if (limitedRoleId) {
    await db.delete(platformMemberships).where(eq(platformMemberships.platformRoleId, limitedRoleId));
    await db.delete(platformRolePermissions).where(eq(platformRolePermissions.platformRoleId, limitedRoleId));
    await db.delete(platformRoles).where(eq(platformRoles.id, limitedRoleId));
  }
  await queryClient.end();
});

// 1, 32 ------------------------------------------------------------------------------------------
test("1. a PLATFORM_ADMIN creates a proposal: UL-P number, draft status, v1 draft, created events, no commercial side effects", async () => {
  const p = await readyProposal();
  const detail = await call("GET", `/platform/proposals/${p.proposalId}`, admin.token);
  assert.equal(detail.status, 200);
  assert.match(detail.data.number, /^UL-P-\d{4}-\d{6,}$/);
  assert.equal(detail.data.status, "draft");
  assert.equal(detail.data.versions.length, 1);
  assert.equal(detail.data.versions[0].status, "draft");
  assert.equal(detail.data.currentVersionId, p.versionId);
  const events = await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, p.proposalId));
  assert.deepEqual(events.map((e) => e.t), ["proposal.created"]);
  const versionEvents = await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, p.versionId));
  assert.deepEqual(versionEvents.map((e) => e.t), ["proposal.version.created"]);
  const subs = await db.execute(sql`select count(*)::int as n from subscriptions where organization_id = ${activeOrgId}`);
  const access = await db.execute(sql`select count(*)::int as n from organization_application_access where organization_id = ${activeOrgId}`);
  assert.equal((subs[0] as { n: number }).n, 0, "a proposal never creates a subscription");
  assert.equal((access[0] as { n: number }).n, 0, "a proposal never grants application access");
});

// 2, 19 ------------------------------------------------------------------------------------------
test("2/19. without the platform permission: org OWNER 403, read-only platform role 403 on manage/send, service key 403, anonymous 401", async () => {
  const body = { prospectCompanyName: "X", recipientName: "Y", recipientEmail: "y@test.ul-platform.invalid" };
  assert.equal((await call("POST", "/platform/proposals", ownerToken, body)).status, 403);
  assert.equal((await call("GET", "/platform/proposals", ownerToken)).status, 403);
  assert.equal((await call("POST", "/platform/proposals", readOnly.token, body)).status, 403);
  assert.equal((await call("GET", "/platform/proposals", readOnly.token)).status, 200, "read-only may read");
  const p = await readyProposal();
  const send = await call("POST", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/send`, readOnly.token);
  assert.equal(send.status, 403);
  assert.equal(send.code, "FORBIDDEN");
  assert.equal((await call("POST", `/platform/proposals/${p.proposalId}/links`, readOnly.token, {})).status, 403);
  await grantTestApplicationAccess(activeOrgId, "NA_PISTA");
  const key = await createOrganizationApiKey({ organizationId: activeOrgId, applicationKey: "NA_PISTA", actorUserId: owner.id, scopes: ["usage.read"] });
  assert.equal((await call("GET", "/platform/proposals", key.secret)).status, 403, "service credentials never reach the platform plane");
  assert.equal((await call("GET", "/platform/proposals")).status, 401);
});

// 3 ----------------------------------------------------------------------------------------------
test("3. organizationId is verified server-side: unknown 404, suspended 409, never accepted blindly", async () => {
  const base = { prospectCompanyName: "X", recipientName: "Y", recipientEmail: "y@test.ul-platform.invalid" };
  assert.equal((await call("POST", "/platform/proposals", admin.token, { ...base, organizationId: randomUUID() })).status, 404);
  const suspended = await call("POST", "/platform/proposals", admin.token, { ...base, organizationId: suspendedOrgId });
  assert.equal(suspended.status, 409);
  const prospect = await call("POST", "/platform/proposals", admin.token, base);
  assert.equal(prospect.status, 201, "a prospect without organization is allowed");
  assert.equal(prospect.data.organizationId, null);
  const patched = await call("PATCH", `/platform/proposals/${prospect.data.id}`, admin.token, { organizationId: suspendedOrgId });
  assert.equal(patched.status, 409);
});

// 5, 7, 8, 9 ------------------------------------------------------------------------------------
test("5/7/8/9. draft editing: version fields, options (single recommended), items with server-computed totals", async () => {
  const p = await readyProposal();
  const edited = await call("PATCH", `/platform/proposals/${p.proposalId}/versions/${p.versionId}`, admin.token, { summary: "Novo resumo" });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.summary, "Novo resumo");
  const second = await call("POST", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options`, admin.token, { name: "Advanced", isRecommended: true, sort: 1 });
  assert.equal(second.status, 201);
  assert.deepEqual(second.data.options.map((o: { name: string; isRecommended: boolean }) => [o.name, o.isRecommended]), [["Essencial", false], ["Advanced", true]]);
  const advancedId = second.data.options[1].id;
  const withItems = await call("POST", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options/${advancedId}/items`, admin.token, {
    kind: "service",
    title: "Suporte presencial",
    quantity: 3,
    unitPriceMinor: "5000000",
  });
  assert.equal(withItems.status, 201);
  const advanced = withItems.data.options[1];
  assert.equal(advanced.items[0].lineTotalMinor, "15000000");
  assert.equal(advanced.totalMinor, "15000000");
  assert.equal(typeof advanced.totalMinor, "string", "bigint never escapes to JSON");
  const updated = await call("PATCH", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options/${advancedId}/items/${advanced.items[0].id}`, admin.token, { quantity: 2 });
  assert.equal(updated.data.options[1].totalMinor, "10000000");
  const removed = await call("DELETE", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options/${advancedId}/items/${advanced.items[0].id}`, admin.token);
  assert.equal(removed.data.options[1].totalMinor, "0");
  const deleted = await call("DELETE", `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options/${advancedId}`, admin.token);
  assert.equal(deleted.data.options.length, 1);
});

// 10, 11, 13 --------------------------------------------------------------------------------------
test("10/11/13. invalid quantity, invalid money and incoherent application/plan are refused", async () => {
  const p = await readyProposal();
  const items = `/platform/proposals/${p.proposalId}/versions/${p.versionId}/options/${p.optionId}/items`;
  for (const quantity of [0, -1, 1.5]) {
    assert.equal((await call("POST", items, admin.token, { kind: "service", title: "x", quantity, unitPriceMinor: "1" })).status, 400);
  }
  for (const unitPriceMinor of ["-1", "1.5", 1.5, "1e6", "abc", "99999999999999999999"]) {
    assert.equal((await call("POST", items, admin.token, { kind: "service", title: "x", quantity: 1, unitPriceMinor })).status, 400, String(unitPriceMinor));
  }
  assert.equal((await call("POST", items, admin.token, { kind: "application_plan", title: "x", applicationKey: "NOPE", planKey: "BUSINESS", unitPriceMinor: "1" })).status, 404);
  assert.equal((await call("POST", items, admin.token, { kind: "application_plan", title: "x", applicationKey: "QUALE_A_DICA", planKey: "STARTER", unitPriceMinor: "1" })).status, 404, "STARTER belongs to NA_PISTA, not QD");
  assert.equal((await call("POST", items, admin.token, { kind: "application_plan", title: "x", applicationKey: "NA_PISTA", unitPriceMinor: "1" })).status, 400);
  assert.equal((await call("POST", items, admin.token, { kind: "service", title: "x", planKey: "BUSINESS", unitPriceMinor: "1" })).status, 400);
});

// 12, 14, 15, 16, 17, 34 -------------------------------------------------------------------------
test("12/14/15/16/17/34. send preconditions: totals, terms present and approved, options, recommended — failures leave the draft untouched", async () => {
  const sendPath = (p: { proposalId: string; versionId: string }) => `/platform/proposals/${p.proposalId}/versions/${p.versionId}/send`;

  const noTerms = await readyProposal({ termsTemplateId: null });
  assert.equal((await call("POST", sendPath(noTerms), admin.token)).status, 409);

  const draftTerms = await readyProposal({ termsTemplateId: await approvedTerms(admin.user.id, "draft") });
  assert.equal((await call("POST", sendPath(draftTerms), admin.token)).status, 409);

  const created = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "X", recipientName: "Y", recipientEmail: "y@test.ul-platform.invalid", validUntil: future(), termsTemplateId: termsId });
  const noOption = { proposalId: created.data.id, versionId: created.data.versions[0].id };
  assert.equal((await call("POST", sendPath(noOption), admin.token)).status, 409);

  const twoOptions = await readyProposal();
  await call("POST", `/platform/proposals/${twoOptions.proposalId}/versions/${twoOptions.versionId}/options`, admin.token, { name: "Advanced" });
  await call("PATCH", `/platform/proposals/${twoOptions.proposalId}/versions/${twoOptions.versionId}/options/${twoOptions.optionId}`, admin.token, { isRecommended: false });
  const opts = await call("GET", `/platform/proposals/${twoOptions.proposalId}/versions/${twoOptions.versionId}`, admin.token);
  await call("POST", `/platform/proposals/${twoOptions.proposalId}/versions/${twoOptions.versionId}/options/${opts.data.options[1].id}/items`, admin.token, { kind: "service", title: "x", unitPriceMinor: "1" });
  assert.equal((await call("POST", sendPath(twoOptions), admin.token)).status, 409, "two options and none recommended");

  const corrupt = await readyProposal();
  await db.update(proposalOptions).set({ totalMinor: 1n }).where(eq(proposalOptions.id, corrupt.optionId)); // draft rows may be changed
  assert.equal((await call("POST", sendPath(corrupt), admin.token)).status, 409, "inconsistent option total");

  // 34: every refused send rolled back — still draft, no snapshot, no send event.
  for (const p of [noTerms, draftTerms, noOption, twoOptions, corrupt]) {
    const [v] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, p.versionId));
    assert.equal(v!.status, "draft");
    assert.equal(v!.contentSha256, null);
    const sentEvents = await db.select().from(commercialEvents).where(and(eq(commercialEvents.aggregateId, p.versionId), eq(commercialEvents.eventType, "proposal.version.sent")));
    assert.equal(sentEvents.length, 0);
  }
});

test("34. a failing create rolls back entirely (no proposal row, no event)", async () => {
  const email = `b1b-rollback+${randomUUID()}@test.ul-platform.invalid`;
  const res = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "X", recipientName: "Y", recipientEmail: email, termsTemplateId: randomUUID() });
  assert.equal(res.status, 404);
  assert.equal((await db.select().from(proposals).where(eq(proposals.recipientEmail, email))).length, 0);
});

// 18, 21, 33, 32 ---------------------------------------------------------------------------------
test("18/21/33. send freezes the version with a canonical SHA-256 (recomputable), marks the proposal sent, is idempotent, audited once", async () => {
  const { proposalId, versionId, sent } = await sendReady();
  assert.equal(sent.data.status, "sent");
  assert.match(sent.data.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(sent.data.hashAlg, "sha256-jcs-v1");
  const [v] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, versionId));
  assert.equal(canonicalSha256(v!.snapshot), v!.contentSha256, "the stored snapshot re-hashes to the stored hash");
  assert.equal(JSON.stringify(v!.snapshot).includes("nota interna"), false, "internal notes are not part of the sent content");
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  assert.equal(p!.status, "sent");
  const again = await call("POST", `/platform/proposals/${proposalId}/versions/${versionId}/send`, admin.token);
  assert.equal(again.status, 200);
  assert.equal(again.data.contentSha256, sent.data.contentSha256);
  const sentEvents = await db.select().from(commercialEvents).where(and(eq(commercialEvents.aggregateId, versionId), eq(commercialEvents.eventType, "proposal.version.sent")));
  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0]!.idempotencyKey, `proposal.version.sent:${versionId}`);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, versionId), eq(auditLogs.action, "platform.commercial.proposal.sent")));
  assert.equal(audits.length, 1);
});

// 6, 20 ------------------------------------------------------------------------------------------
test("6/20. a sent version is immutable through the API (409 COMMERCIAL_RECORD_IMMUTABLE) and in the database", async () => {
  const { proposalId, versionId, optionId, itemId } = await sendReady();
  const v = `/platform/proposals/${proposalId}/versions/${versionId}`;
  for (const [method, path, body] of [
    ["PATCH", v, { summary: "mudança" }],
    ["POST", `${v}/options`, { name: "Nova" }],
    ["PATCH", `${v}/options/${optionId}`, { name: "x" }],
    ["DELETE", `${v}/options/${optionId}`, undefined],
    ["POST", `${v}/options/${optionId}/items`, { kind: "service", title: "x", unitPriceMinor: "1" }],
    ["PATCH", `${v}/options/${optionId}/items/${itemId}`, { quantity: 9 }],
    ["DELETE", `${v}/options/${optionId}/items/${itemId}`, undefined],
  ] as const) {
    const res = await call(method, path, admin.token, body);
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(res.code, "COMMERCIAL_RECORD_IMMUTABLE");
  }
  assert.equal((await call("PATCH", `/platform/proposals/${proposalId}`, admin.token, { recipientName: "Outro" })).code, "COMMERCIAL_RECORD_IMMUTABLE");
  await assert.rejects(
    async () => {
      await db.update(proposalVersions).set({ summary: "x" }).where(eq(proposalVersions.id, versionId));
    },
    (e: unknown) => {
      const err = e as { code?: string; cause?: { code?: string } };
      return (err.cause?.code ?? err.code) === "UL001";
    },
  );
});

// 4, 22 ------------------------------------------------------------------------------------------
test("4/22. a new version is a draft copy; one draft at a time; changing content changes the hash; the old version is superseded", async () => {
  const { proposalId, versionId, sent } = await sendReady();
  const v2 = await call("POST", `/platform/proposals/${proposalId}/versions`, admin.token);
  assert.equal(v2.status, 201);
  assert.equal(v2.data.versionNo, 2);
  assert.equal(v2.data.status, "draft");
  assert.equal(v2.data.options[0].items[0].unitPriceMinor, "20000000", "options and items are copied");
  assert.equal((await call("POST", `/platform/proposals/${proposalId}/versions`, admin.token)).status, 409, "only one draft at a time");
  const opt = v2.data.options[0];
  await call("PATCH", `/platform/proposals/${proposalId}/versions/${v2.data.id}/options/${opt.id}/items/${opt.items[0].id}`, admin.token, { unitPriceMinor: "18000000" });
  const sent2 = await call("POST", `/platform/proposals/${proposalId}/versions/${v2.data.id}/send`, admin.token);
  assert.equal(sent2.status, 200);
  assert.notEqual(sent2.data.contentSha256, sent.data.contentSha256);
  const [old] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, versionId));
  assert.equal(old!.status, "superseded");
  assert.equal(old!.contentSha256, sent.data.contentSha256, "the superseded version keeps its frozen content");
});

// 23, 24, 25, 29, 30, 31, 33 ---------------------------------------------------------------------
test("23/24/25/29/30. links: token returned once and stored only as SHA-256; public read is read-only and leaks nothing internal", async () => {
  const { proposalId } = await sendReady();
  const created = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, {});
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const token = created.data.token as string;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.data.path, `/p/${token}`);
  assert.equal(JSON.stringify(created.data.link).includes(token), false);

  const [row] = await db.select().from(proposalAccessLinks).where(eq(proposalAccessLinks.id, created.data.link.id));
  assert.equal(row!.tokenSha256, sha(token));
  const leak = await db.execute(sql`
    select (select count(*) from proposal_access_links where token_sha256 = ${token})
         + (select count(*) from commercial_events where payload::text like ${`%${token}%`})
         + (select count(*) from audit_logs where metadata::text like ${`%${token}%`}) as n`);
  assert.equal(Number((leak[0] as { n: string }).n), 0, "the plaintext token is persisted nowhere");
  const listed = await call("GET", `/platform/proposals/${proposalId}/links`, admin.token);
  assert.equal(listed.raw.includes(token), false);
  assert.equal(listed.raw.includes(row!.tokenSha256), false, "admin views never expose the token hash either");

  const pub = await call("POST", "/public/proposals/resolve", undefined, { token });
  assert.equal(pub.status, 200, pub.raw);
  assert.equal(pub.headers.get("cache-control"), "no-store");
  assert.equal(pub.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(pub.headers.get("set-cookie"), null, "no session is issued");
  assert.deepEqual(pub.data.acceptance, { available: false });
  assert.equal(pub.data.options[0].items[0].lineTotalMinor, "20000000");
  for (const forbidden of [proposalId, activeOrgId, row!.tokenSha256, admin.user.id, "@test.ul-platform.invalid", "contentSha256", "bodySha256", "organizationId", "nota interna", "entitlementSpec"]) {
    assert.equal(pub.raw.includes(forbidden), false, `public response must not contain ${forbidden}`);
  }
  assert.equal((await call("GET", "/me", token)).status, 401, "a link token is not a credential");
  assert.equal((await call("GET", `/platform/proposals/${proposalId}`, token)).status, 401);
});

test("25/32/33. first view: proposal sent → viewed and ONE proposal.viewed event per link; views are counted", async () => {
  const { proposalId } = await sendReady();
  const { data } = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, {});
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/public/proposals/resolve", undefined, { token: data.token })).status, 200);
  const [p] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  assert.equal(p!.status, "viewed");
  const viewed = await db.select().from(commercialEvents).where(and(eq(commercialEvents.aggregateId, proposalId), eq(commercialEvents.eventType, "proposal.viewed")));
  assert.equal(viewed.length, 1);
  assert.equal(viewed[0]!.actorType, "public_link");
  const [link] = await db.select().from(proposalAccessLinks).where(eq(proposalAccessLinks.id, data.link.id));
  assert.equal(link!.viewCount, 3);
  const types = (await db.select({ t: commercialEvents.eventType }).from(commercialEvents).where(eq(commercialEvents.aggregateId, data.link.id))).map((e) => e.t);
  assert.deepEqual(types, ["proposal.access_link.created"]);
});

// 26, 27, 28, 31 --------------------------------------------------------------------------------
test("26/27/28/31. invalid, malformed, expired, exhausted and revoked tokens all get the same 404; revocation is idempotent and audited", async () => {
  const { proposalId } = await sendReady();
  const notAvailable = async (body: unknown) => {
    const res = await call("POST", "/public/proposals/resolve", undefined, body);
    assert.equal(res.status, 404, JSON.stringify(body));
    assert.equal(res.code, "NOT_FOUND");
    return res.raw;
  };
  const uniform = await notAvailable({ token: randomBytes(32).toString("base64url") });
  assert.equal(await notAvailable({ token: "short" }), uniform);
  assert.equal(await notAvailable({}), uniform);
  assert.equal(await notAvailable({ token: "x".repeat(43), extra: 1 }), uniform);

  const expired = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, {});
  await db.update(proposalAccessLinks).set({ expiresAt: sql`created_at + interval '1 millisecond'` }).where(eq(proposalAccessLinks.id, expired.data.link.id));
  assert.equal(await notAvailable({ token: expired.data.token }), uniform);

  const once = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, { maxViews: 1 });
  assert.equal((await call("POST", "/public/proposals/resolve", undefined, { token: once.data.token })).status, 200);
  assert.equal(await notAvailable({ token: once.data.token }), uniform);

  const revoked = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, {});
  assert.equal((await call("POST", "/public/proposals/resolve", undefined, { token: revoked.data.token })).status, 200);
  const r1 = await call("POST", `/platform/proposals/${proposalId}/links/${revoked.data.link.id}/revoke`, admin.token);
  assert.equal(r1.status, 200);
  assert.ok(r1.data.revokedAt);
  const r2 = await call("POST", `/platform/proposals/${proposalId}/links/${revoked.data.link.id}/revoke`, admin.token);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.revokedAt, r1.data.revokedAt, "idempotent");
  assert.equal(await notAvailable({ token: revoked.data.token }), uniform);
  const events = await db.select().from(commercialEvents).where(and(eq(commercialEvents.aggregateId, revoked.data.link.id), eq(commercialEvents.eventType, "proposal.access_link.revoked")));
  assert.equal(events.length, 1);
  const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, revoked.data.link.id), eq(auditLogs.action, "platform.commercial.access_link.revoked")));
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits[0]!.metadata).includes(revoked.data.token), false);
});

test("links: only for a sent version, never beyond valid_until, never in the past", async () => {
  const draft = await readyProposal();
  assert.equal((await call("POST", `/platform/proposals/${draft.proposalId}/links`, admin.token, {})).status, 409, "a draft proposal has no public content");
  const { proposalId } = await sendReady();
  const [v] = await db.select().from(proposalVersions).where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.status, "sent")));
  const beyond = new Date(v!.validUntil!.getTime() + 86_400_000).toISOString();
  assert.equal((await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, { expiresAt: beyond })).status, 400);
  assert.equal((await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, { expiresAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
  const earlier = new Date(Date.now() + 86_400_000).toISOString();
  const ok = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, { expiresAt: earlier });
  assert.equal(ok.status, 201);
  assert.equal(new Date(ok.data.link.expiresAt).toISOString(), earlier);
  const dflt = await call("POST", `/platform/proposals/${proposalId}/links`, admin.token, {});
  assert.equal(new Date(dflt.data.link.expiresAt).getTime(), v!.validUntil!.getTime(), "expiresAt defaults to valid_until");
});

test("30. a link of proposal A only ever shows proposal A", async () => {
  const a = await sendReady();
  const b = await sendReady();
  await call("POST", `/platform/proposals/${b.proposalId}/links`, admin.token, {});
  const linkA = await call("POST", `/platform/proposals/${a.proposalId}/links`, admin.token, {});
  const [pa] = await db.select().from(proposals).where(eq(proposals.id, a.proposalId));
  const [pb] = await db.select().from(proposals).where(eq(proposals.id, b.proposalId));
  const pub = await call("POST", "/public/proposals/resolve", undefined, { token: linkA.data.token });
  assert.equal(pub.data.proposal.number, pa!.number);
  assert.equal(pub.raw.includes(pb!.number), false);
});

test("a version is only reachable through its own proposal (no cross-proposal access by id)", async () => {
  const a = await sendReady();
  const b = await readyProposal();
  assert.equal((await call("GET", `/platform/proposals/${b.proposalId}/versions/${a.versionId}`, admin.token)).status, 404);
  assert.equal((await call("POST", `/platform/proposals/${b.proposalId}/versions/${a.versionId}/send`, admin.token)).status, 404);
  assert.equal((await call("PATCH", `/platform/proposals/${b.proposalId}/versions/${b.versionId}/options/${a.optionId}`, admin.token, { name: "x" })).status, 404);
});

test("error mapping: UL001 → 409 COMMERCIAL_RECORD_IMMUTABLE, 23514/23503 → 409 CONFLICT (driver errors wrapped as drizzle does), others unchanged", async () => {
  const { errorHandler } = await import("../src/middleware/errorHandler.js");
  const express = (await import("express")).default;
  const probe = express();
  const wrapped = (code: string) => Object.assign(new Error("DrizzleQueryError"), { cause: Object.assign(new Error("postgres"), { code }) });
  probe.get("/:code", (req, _res, next) => next(wrapped(req.params.code!)));
  probe.use(errorHandler);
  const s = probe.listen(0);
  try {
    const at = async (code: string) => {
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/${code}`);
      return { status: r.status, code: ((await r.json()) as { error: { code: string } }).error.code };
    };
    assert.deepEqual(await at("UL001"), { status: 409, code: "COMMERCIAL_RECORD_IMMUTABLE" });
    assert.deepEqual(await at("23514"), { status: 409, code: "CONFLICT" });
    assert.deepEqual(await at("23503"), { status: 409, code: "CONFLICT" });
    assert.deepEqual(await at("23505"), { status: 409, code: "CONFLICT" });
    assert.deepEqual(await at("42P01"), { status: 500, code: "INTERNAL_ERROR" }, "unrelated driver errors stay 500");
  } finally {
    s.close();
  }
});
