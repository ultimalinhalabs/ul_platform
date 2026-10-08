import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  apiKeys,
  credentialProvisioningRequests,
  memberships,
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
  roles,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey } from "../src/modules/apiKeys/service.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * UL Console MVP — platform commercial READ APIs, over HTTP against the disposable test database
 * (guarded). Real authorization end to end (local JWTs signed with the TEST secret, real platform
 * roles/permissions, real API keys) — nothing mocked. The fixture chain goes through the official API:
 * proposal → send → OWNER acceptance → contract → activation → provisioning issue → confirm.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const future = (ms = 30 * 86_400_000) => new Date(Date.now() + ms).toISOString();

type User = { id: string; email: string };
type Json = ReturnType<typeof JSON.parse>;
type Res = { status: number; data: Json; code?: string; raw: string };

async function tokenFor(user: User, expiresIn = "10m") {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime(expiresIn)
    .sign(secret);
}

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(base() + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let json: Json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: res.status, data: json?.data, code: json?.error?.code, raw };
}
const get = (path: string, token?: string) => call("GET", path, token);

const createdAuthUsers: string[] = [];
const platformUsers: string[] = [];
const testRoleIds: string[] = [];

async function person(prefix: string) {
  const user = await createTestUser(`pcr-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, now())`);
  return { user, token: await tokenFor(user) };
}

async function platformPersonWithRole(roleId: string, prefix: string) {
  const p = await person(prefix);
  await db.insert(platformMemberships).values({ userId: p.user.id, platformRoleId: roleId, status: "ACTIVE" });
  platformUsers.push(p.user.id);
  return p;
}

async function testPlatformRole(permissionKeys: string[]) {
  const [role] = await db.insert(platformRoles).values({ key: `TEST_PCR_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test PCR role" }).returning();
  testRoleIds.push(role!.id);
  for (const key of permissionKeys) {
    const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, key));
    await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  }
  return role!.id;
}

let admin: { user: User; token: string };
let readOnly: { user: User; token: string };
let noCommercial: { user: User; token: string };
let plainUser: { user: User; token: string };
let termsId: string;
let provisioner: string;
let fixture: { orgId: string; otherOrgId: string; contractId: string; prId: string; credentialId: string; credentialToken: string; owner: { user: User; token: string }; orgKey: string };

const NA = { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "20000000", billingPeriod: "monthly", durationMonths: 1 };

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  const [adminRole] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  admin = await platformPersonWithRole(adminRole!.id, "admin");
  readOnly = await platformPersonWithRole(await testPlatformRole(["platform.commercial.read"]), "readonly");
  // A platform member whose role carries other platform permissions but NOT platform.commercial.read.
  noCommercial = await platformPersonWithRole(await testPlatformRole(["platform.audit.read", "platform.proposal.manage"]), "nocommercial");
  plainUser = await person("plain");

  const body = `Termos de TESTE PCR ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`pcr-${randomUUID().slice(0, 8)}`}, 1, 'Termos PCR', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
  const p = await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: ["credential.provision"], purpose: "PROVISIONER" });
  assert.equal(p.status, 201, p.raw);
  provisioner = p.data.secret;

  // Fixture chain through the official API.
  const owner = await person("owner");
  const org = await createTestOrganization("pcr-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const created = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "Cliente PCR", recipientName: "Dest", recipientEmail: owner.user.email, organizationId: org.id, validUntil: future(), termsTemplateId: termsId });
  assert.equal(created.status, 201, created.raw);
  const v = `/platform/proposals/${created.data.id}/versions/${created.data.versions[0].id}`;
  const opt = await call("POST", `${v}/options`, admin.token, { name: "Opção", isRecommended: true });
  const optionId = opt.data.options[0].id as string;
  assert.equal((await call("POST", `${v}/options/${optionId}/items`, admin.token, { ...NA, sort: 0 })).status, 201);
  const sent = await call("POST", `${v}/send`, admin.token);
  assert.equal(sent.status, 200, sent.raw);
  const acc = await call("POST", `/proposals/${created.data.id}/acceptance`, owner.token, { versionId: created.data.versions[0].id, optionId, contentSha256: sent.data.contentSha256, signerName: "Signatário", consent: true }, { "idempotency-key": `k-${randomUUID()}` });
  assert.equal(acc.status, 201, acc.raw);
  const contractId = acc.data.contract.id as string;
  assert.equal((await call("POST", `/platform/contracts/${contractId}/activation`, admin.token)).status, 201);
  const [pr] = await db.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.organizationId, org.id));
  const issued = await call("POST", `/service/credential-provisionings/${pr!.id}/issue`, provisioner, { expectedIssueCount: 0 });
  assert.equal(issued.status, 201, issued.raw);
  const credentialToken = issued.data.credential.token as string;
  assert.equal((await call("POST", `/service/credential-provisionings/${pr!.id}/confirm`, credentialToken)).status, 200);

  const otherOwner = await person("other-owner");
  const otherOrg = await createTestOrganization("pcr-other", otherOwner.user.id);
  await db.insert(memberships).values({ userId: otherOwner.user.id, organizationId: otherOrg.id, roleId: ownerRole!.id, status: "active" });
  await grantTestApplicationAccess(otherOrg.id, "NA_PISTA");
  const key = await createOrganizationApiKey({ organizationId: otherOrg.id, applicationKey: "NA_PISTA", actorUserId: otherOwner.user.id, scopes: ["usage.read"] });

  fixture = { orgId: org.id, otherOrgId: otherOrg.id, contractId, prId: pr!.id, credentialId: issued.data.credential.id, credentialToken, owner, orgKey: key.secret };
});

after(async () => {
  server.close();
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  for (const id of testRoleIds) {
    await db.delete(platformRolePermissions).where(eq(platformRolePermissions.platformRoleId, id));
    await db.delete(platformRoles).where(eq(platformRoles.id, id));
  }
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

const ENDPOINTS = () => [
  "/platform/organizations",
  `/platform/organizations/${fixture.orgId}`,
  `/platform/organizations/${fixture.orgId}/members`,
  "/platform/commercial/terms",
  "/platform/contracts",
  "/platform/credential-provisionings",
  "/platform/commercial/events",
  "/platform/commercial/summary",
];

/** Secrets, hashes and credential material that must never appear in any response body. */
async function forbiddenStrings() {
  const [k] = await db.select({ secretHash: apiKeys.secretHash }).from(apiKeys).where(eq(apiKeys.id, fixture.credentialId));
  return [fixture.credentialToken, provisioner, fixture.orgKey, k!.secretHash, env.SUPABASE_JWT_SECRET, admin.token];
}
const FORBIDDEN_KEYS = /"(secret|secretHash|secret_hash|token|tokenHash|token_hash|encrypted\w*|password|body|refreshToken|serviceRole\w*)"\s*:/i;

// ------------------------------------------------------------------------------------------- 1–4, 10

test("1. anonymous → 401 on every endpoint", async () => {
  for (const path of ENDPOINTS()) assert.equal((await get(path)).status, 401, path);
});

test("2. authenticated user without platform membership → 403 (incl. the organization's own OWNER)", async () => {
  for (const path of ENDPOINTS()) {
    assert.equal((await get(path, plainUser.token)).status, 403, path);
    assert.equal((await get(path, fixture.owner.token)).status, 403, `OWNER ${path}`);
  }
});

test("3. platform member without platform.commercial.read → 403", async () => {
  for (const path of ENDPOINTS()) {
    const r = await get(path, noCommercial.token);
    assert.equal(r.status, 403, path);
    assert.equal(r.code, "FORBIDDEN", path);
  }
});

test("4. PLATFORM_ADMIN and a read-only commercial role → 200 with the response envelope", async () => {
  for (const path of ENDPOINTS()) {
    for (const who of [admin, readOnly]) {
      const r = await get(path, who.token);
      assert.equal(r.status, 200, `${path}: ${r.raw}`);
      assert.ok(r.data !== undefined, path);
    }
  }
});

test("10. no privilege escalation: service credentials (org key, managed credential, provisioner) and expired JWTs never reach these routes; reads never mutate", async () => {
  const expired = await tokenFor(admin.user, "-1m");
  const before = await get("/platform/commercial/summary", admin.token);
  for (const path of ENDPOINTS()) {
    for (const token of [fixture.orgKey, fixture.credentialToken, provisioner]) assert.equal((await get(path, token)).status, 403, path);
    assert.equal((await get(path, expired)).status, 401, `expired ${path}`);
  }
  // Read-only role cannot use the write endpoints the console also calls.
  assert.equal((await call("POST", `/platform/contracts/${fixture.contractId}/termination`, readOnly.token, { reason: "x" })).status, 403);
  assert.equal((await call("POST", `/platform/credential-provisionings/${fixture.prId}/revoke`, readOnly.token, { reason: "x" })).status, 403);
  // Only GET is routed: no write verb exists on the new paths.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await call(method, "/platform/commercial/terms", admin.token, {})).status, 404, method);
  const afterSummary = await get("/platform/commercial/summary", admin.token);
  assert.deepEqual(afterSummary.data, before.data, "reading changes nothing");
});

// ------------------------------------------------------------------------------------------- 5–6, 14

test("5. tenant isolation: organization detail, members, contracts, provisioning and events return only the requested organization", async () => {
  const detail = await get(`/platform/organizations/${fixture.orgId}`, admin.token);
  assert.equal(detail.data.organization.id, fixture.orgId);
  assert.equal(detail.data.contracts.length, 1);
  assert.ok(detail.data.contracts.every((c: { organizationId: string }) => c.organizationId === fixture.orgId));
  assert.ok(detail.data.provisioning.every((p: { organizationId: string }) => p.organizationId === fixture.orgId));
  assert.equal(detail.data.subscriptions.length, 1);
  assert.deepEqual(detail.data.applications.map((a: { applicationKey: string; effective: boolean }) => [a.applicationKey, a.effective]), [["NA_PISTA", true]]);

  const other = await get(`/platform/organizations/${fixture.otherOrgId}`, admin.token);
  assert.deepEqual(other.data.contracts, []);
  assert.deepEqual(other.data.provisioning, []);
  assert.ok(!JSON.stringify(other.data).includes(fixture.contractId));

  const members = await get(`/platform/organizations/${fixture.orgId}/members`, admin.token);
  assert.deepEqual(members.data.map((m: { email: string }) => m.email), [fixture.owner.user.email]);
  const otherMembers = await get(`/platform/organizations/${fixture.otherOrgId}/members`, admin.token);
  assert.ok(!otherMembers.data.some((m: { email: string }) => m.email === fixture.owner.user.email));

  const contracts = await get(`/platform/contracts?organizationId=${fixture.otherOrgId}`, admin.token);
  assert.deepEqual(contracts.data.items, []);
  const prs = await get(`/platform/credential-provisionings?organizationId=${fixture.otherOrgId}`, admin.token);
  assert.deepEqual(prs.data.items, []);
  const events = await get(`/platform/commercial/events?organizationId=${fixture.orgId}&limit=100`, admin.token);
  assert.ok(events.data.items.length > 0);
  assert.ok(events.data.items.every((e: { organizationId: string }) => e.organizationId === fixture.orgId));
});

test("6/14. unknown resource → 404 NOT_FOUND; malformed IDs → 400 VALIDATION_ERROR (never reach SQL)", async () => {
  for (const path of [`/platform/organizations/${randomUUID()}`, `/platform/organizations/${randomUUID()}/members`]) {
    const r = await get(path, admin.token);
    assert.equal(r.status, 404, path);
    assert.equal(r.code, "NOT_FOUND");
  }
  for (const bad of ["abc", "1", "' or 1=1 --", "00000000-0000-0000-0000-00000000000g"]) {
    const enc = encodeURIComponent(bad);
    for (const path of [`/platform/organizations/${enc}`, `/platform/organizations/${enc}/members`, `/platform/contracts?organizationId=${enc}`, `/platform/credential-provisionings?organizationId=${enc}`, `/platform/commercial/events?organizationId=${enc}`]) {
      const r = await get(path, admin.token);
      assert.equal(r.status, 400, `${path}: ${r.raw}`);
      assert.equal(r.code, "VALIDATION_ERROR");
    }
  }
});

// ------------------------------------------------------------------------------------------- 7–9

test("7/8/9. no secret, hash, token or service credential appears in any response (and no such key exists)", async () => {
  const forbidden = await forbiddenStrings();
  const paths = [...ENDPOINTS(), `/platform/organizations/${fixture.otherOrgId}`, `/platform/credential-provisionings?organizationId=${fixture.orgId}`, "/platform/commercial/events?limit=100"];
  for (const path of paths) {
    const r = await get(path, admin.token);
    assert.equal(r.status, 200, path);
    for (const s of forbidden) assert.ok(!r.raw.includes(s), `${path} leaks a secret`);
    assert.ok(!FORBIDDEN_KEYS.test(r.raw), `${path} exposes a forbidden key: ${r.raw.match(FORBIDDEN_KEYS)?.[0]}`);
    assert.ok(!/ulk_/.test(r.raw), `${path} contains an API key prefix`);
  }
  const prs = await get(`/platform/credential-provisionings?organizationId=${fixture.orgId}`, admin.token);
  const pr = prs.data.items[0];
  assert.deepEqual(Object.keys(pr.credential).sort(), ["createdAt", "id", "revokedAt", "status"], "only the managed credential's public lifecycle");
  assert.equal(pr.credential.status, "ACTIVE");
  const terms = await get("/platform/commercial/terms", admin.token);
  const t = terms.data.find((x: { id: string }) => x.id === termsId);
  assert.deepEqual(Object.keys(t).sort(), ["approvedAt", "approvedBy", "contentSha256", "createdAt", "id", "key", "status", "title", "updatedAt", "version"]);
  const members = await get(`/platform/organizations/${fixture.orgId}/members`, admin.token);
  assert.deepEqual(Object.keys(members.data[0]).sort(), ["createdAt", "email", "membershipId", "role", "status"], "members: no user id or auth data");
});

// ------------------------------------------------------------------------------------------- 11–13, 15

test("11. pagination limits: limit capped at 100, default applied, keyset cursor pages without overlap", async () => {
  for (const path of ["/platform/organizations", "/platform/contracts", "/platform/credential-provisionings", "/platform/commercial/events"]) {
    assert.equal((await get(`${path}?limit=101`, admin.token)).status, 400, path);
    assert.equal((await get(`${path}?limit=0`, admin.token)).status, 400, path);
    assert.equal((await get(`${path}?limit=-1`, admin.token)).status, 400, path);
    assert.equal((await get(`${path}?cursor=${Buffer.from("not|a-cursor").toString("base64url")}`, admin.token)).status, 400, `${path} bad cursor`);
  }
  const first = await get("/platform/organizations?limit=1", admin.token);
  assert.equal(first.data.items.length, 1);
  assert.ok(first.data.nextCursor);
  const second = await get(`/platform/organizations?limit=1&cursor=${first.data.nextCursor}`, admin.token);
  const ids1 = first.data.items.map((o: { id: string }) => o.id);
  assert.ok(second.data.items.every((o: { id: string }) => !ids1.includes(o.id)), "no overlap between pages");
  const ev1 = await get("/platform/commercial/events?limit=3", admin.token);
  const ev2 = await get(`/platform/commercial/events?limit=3&cursor=${ev1.data.nextCursor}`, admin.token);
  assert.ok(ev2.data.items.every((e: { id: string }) => !ev1.data.items.some((x: { id: string }) => x.id === e.id)));
});

test("12. invalid filters → 400 (unknown keys, bad enums, inverted date range)", async () => {
  const bad = [
    "/platform/organizations?status=deleted",
    "/platform/organizations?unknown=1",
    "/platform/organizations?search=",
    `/platform/organizations?search=${"x".repeat(101)}`,
    "/platform/contracts?status=signed",
    "/platform/contracts?applicationKey=na_pista;drop",
    "/platform/credential-provisionings?status=PENDING",
    "/platform/commercial/events?eventType=DROP TABLE",
    "/platform/commercial/events?aggregateType=users",
    "/platform/commercial/events?from=not-a-date",
    `/platform/commercial/events?from=${future()}&to=${new Date(0).toISOString()}`,
  ];
  for (const path of bad) assert.equal((await get(path, admin.token)).status, 400, path);
  const ok = await get(`/platform/contracts?status=active&applicationKey=NA_PISTA&organizationId=${fixture.orgId}`, admin.token);
  assert.deepEqual(ok.data.items.map((c: { id: string }) => c.id), [fixture.contractId]);
  assert.deepEqual(ok.data.items[0].applications, ["NA_PISTA"]);
  assert.deepEqual((await get(`/platform/contracts?applicationKey=QUALE_A_DICA&organizationId=${fixture.orgId}`, admin.token)).data.items, []);
  const evs = await get(`/platform/commercial/events?organizationId=${fixture.orgId}&eventType=contract.activated`, admin.token);
  assert.deepEqual(evs.data.items.map((e: { aggregateId: string }) => e.aggregateId), [fixture.contractId]);
});

test("13. stable ordering: createdAt/occurredAt descending, id as tie-break, identical across calls", async () => {
  for (const [path, field] of [["/platform/organizations?limit=100", "createdAt"], ["/platform/contracts?limit=100", "createdAt"], ["/platform/commercial/events?limit=100", "occurredAt"]] as const) {
    const a = await get(path, admin.token);
    const b = await get(path, admin.token);
    assert.deepEqual(a.data.items.map((x: { id: string }) => x.id), b.data.items.map((x: { id: string }) => x.id), path);
    const items = a.data.items as Array<Record<string, string>>;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const cur = items[i]!;
      const ordered = prev[field]! > cur[field]! || (prev[field] === cur[field] && prev.id! > cur.id!);
      assert.ok(ordered, `${path} order at ${i}`);
    }
  }
});

test("15. SQL-injection-safe: search is a literal (wildcards escaped), hostile input changes nothing", async () => {
  const before = await get("/platform/commercial/summary", admin.token);
  for (const term of ["pcr%org", "pcr_org", "pcr\\-org", "'; drop table organizations; --", "pcr-org%' or '1'='1"]) {
    const r = await get(`/platform/organizations?search=${encodeURIComponent(term)}`, admin.token);
    assert.equal(r.status, 200, term);
    assert.equal(r.data.items.length, 0, `"${term}" matched as a literal, not a pattern`);
  }
  const hit = await get(`/platform/organizations?search=pcr-org&limit=100`, admin.token);
  assert.ok(hit.data.items.some((o: { id: string }) => o.id === fixture.orgId));
  assert.deepEqual((await get("/platform/commercial/summary", admin.token)).data, before.data);
});

// ------------------------------------------------------------------------------------------- 16

test("16. response schemas: list items, organization detail, terms, provisioning, events and summary carry the documented fields", async () => {
  const orgs = await get(`/platform/organizations?search=pcr-org&limit=100`, admin.token);
  const o = orgs.data.items.find((x: { id: string }) => x.id === fixture.orgId);
  assert.deepEqual(Object.keys(o).sort(), ["applications", "contracts", "createdAt", "id", "name", "slug", "status"]);
  assert.deepEqual(o.applications, ["NA_PISTA"]);
  assert.deepEqual(o.contracts, { active: 1 });

  const detail = await get(`/platform/organizations/${fixture.orgId}`, admin.token);
  assert.deepEqual(Object.keys(detail.data).sort(), ["applications", "contracts", "organization", "provisioning", "subscriptions"]);

  const c = (await get(`/platform/contracts?organizationId=${fixture.orgId}`, admin.token)).data.items[0];
  for (const k of ["id", "number", "organizationId", "organizationName", "status", "currency", "totalMinor", "currentVersion", "applications", "createdAt"]) assert.ok(k in c, k);
  assert.equal(typeof c.totalMinor, "string", "money stays a string");
  const contractDetail = await get(`/platform/contracts/${fixture.contractId}`, admin.token);
  assert.equal(contractDetail.status, 200);
  for (const k of ["id", "number", "organizationId", "sourceAcceptanceId", "status", "currency", "totalMinor", "currentVersion", "items", "grants"]) assert.ok(k in contractDetail.data, `existing field ${k} kept`);
  assert.deepEqual(Object.keys(contractDetail.data.source).sort(), ["acceptedAt", "optionId", "proposalId", "proposalNumber", "signerName", "termsTemplateId", "versionId", "versionNo"], "additive source: no consent hash, consent text or user agent");
  assert.equal(contractDetail.data.source.versionNo, 1);
  assert.equal(contractDetail.data.source.termsTemplateId, termsId);
  assert.equal((await get(`/platform/contracts/${fixture.contractId}`, readOnly.token)).status, 200);
  assert.equal((await get(`/platform/contracts/${fixture.contractId}`, noCommercial.token)).status, 403);
  assert.equal((await get(`/platform/contracts/${fixture.contractId}`, fixture.owner.token)).status, 403);

  const pr = (await get(`/platform/credential-provisionings?organizationId=${fixture.orgId}`, admin.token)).data.items[0];
  for (const k of ["id", "organizationId", "organizationName", "application", "purpose", "kind", "status", "issueCount", "requestedBy", "contractId", "createdAt", "updatedAt", "credential"]) assert.ok(k in pr, k);
  assert.equal(pr.status, "ACTIVE");
  assert.equal(pr.application, "NA_PISTA");
  assert.equal(pr.issueCount, 1);

  const ev = (await get(`/platform/commercial/events?organizationId=${fixture.orgId}&eventType=contract.activated`, admin.token)).data.items[0];
  for (const k of ["id", "eventType", "aggregateType", "aggregateId", "organizationId", "organizationName", "actorType", "actorUserId", "actorEmail", "payload", "occurredAt"]) assert.ok(k in ev, k);
  assert.equal(ev.actorEmail, admin.user.email);

  const s = (await get("/platform/commercial/summary", admin.token)).data;
  assert.deepEqual(Object.keys(s).sort(), ["contracts", "effectiveApplicationAccess", "effectiveGrants", "effectiveSubscriptions", "managedCredentials", "organizations", "proposals", "provisioningRequests"]);
  assert.ok(s.contracts.byStatus.active >= 1);
  assert.ok(s.managedCredentials.byStatus.ACTIVE >= 1);
  assert.ok(Number.isInteger(s.effectiveSubscriptions));
});

test("platform.audit.read semantics unchanged: tenant/commercial events still excluded from /platform/audit-logs", async () => {
  const r = await get("/platform/audit-logs?limit=100", admin.token);
  assert.equal(r.status, 200);
  assert.ok(r.data.items.every((e: { action: string }) => /^(platform|environment|endpoint|integration)\./.test(e.action)));
  assert.ok(!r.raw.includes(fixture.orgId), "no organization-scoped row");
});
