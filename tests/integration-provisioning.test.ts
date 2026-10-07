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
  apiKeys,
  applications,
  auditLogs,
  credentialProvisioningRequests,
  entitlementGrants,
  memberships,
  organizationApplicationAccess,
  platformMemberships,
  platformRoles,
  roles,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey } from "../src/modules/apiKeys/service.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * D2-B MVP — managed integration credential provisioning, end to end over HTTP on the disposable
 * test database (guarded): contract activation → provisioning request → provisioner issue → PENDING
 * → proof-of-possession confirm → ACTIVE → runtime authorization → revocation/termination/expiry.
 * Local JWTs (TEST secret), minimal `auth.users`; no network beyond the local server; every
 * credential is minted here. Commercial history and provisioning requests are immutable by design
 * (they stay); test platform memberships are removed in `after`.
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

async function person(prefix: string) {
  const user = await createTestUser(`d2b-${prefix}`);
  createdAuthUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, now())`);
  return { user, token: await tokenFor(user) };
}

let admin: { user: User; token: string };
let termsId: string;
let provisioner: string;

const NA = { kind: "application_plan", title: "Na Pista Business", applicationKey: "NA_PISTA", planKey: "BUSINESS", quantity: 1, unitPriceMinor: "20000000", billingPeriod: "monthly", durationMonths: 1 };

/** Real commercial chain through the API: proposal → send → OWNER acceptance → activation (creates the provisioning request). */
async function activeNaPistaContract() {
  const owner = await person("owner");
  const org = await createTestOrganization("d2b-org", owner.user.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.user.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const created = await call("POST", "/platform/proposals", admin.token, { prospectCompanyName: "Cliente D2B", recipientName: "Dest", recipientEmail: owner.user.email, organizationId: org.id, validUntil: future(), termsTemplateId: termsId });
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
  const act = await call("POST", `/platform/contracts/${contractId}/activation`, admin.token);
  assert.equal(act.status, 201, act.raw);
  const [pr] = await db.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.organizationId, org.id));
  assert.ok(pr, "activation created the provisioning request");
  return { orgId: org.id, contractId, owner, prId: pr.id, grantId: act.data.grants[0].id as string };
}

const issue = (prId: string, expectedIssueCount: number, token = provisioner, extra: Record<string, unknown> = {}) =>
  call("POST", `/service/credential-provisionings/${prId}/issue`, token, { expectedIssueCount, ...extra });
const confirm = (prId: string, token: string) => call("POST", `/service/credential-provisionings/${prId}/confirm`, token);
const entitlements = (orgId: string, token: string) => call("GET", `/organizations/${orgId}/applications/NA_PISTA/entitlements`, token);
const usage = (orgId: string, token: string) =>
  call("POST", `/organizations/${orgId}/applications/NA_PISTA/usage`, token, { meterKey: "api_requests", quantity: 1, idempotencyKey: `u-${randomUUID()}` });
const prRow = async (id: string) => (await db.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, id)))[0]!;
const keyRow = async (id: string) => (await db.select().from(apiKeys).where(eq(apiKeys.id, id)))[0]!;

/** Full happy path to an ACTIVE managed credential; returns its token. */
async function provisioned() {
  const c = await activeNaPistaContract();
  const issued = await issue(c.prId, 0);
  assert.equal(issued.status, 201, issued.raw);
  const token = issued.data.credential.token as string;
  assert.equal((await confirm(c.prId, token)).status, 200);
  return { ...c, token, credentialId: issued.data.credential.id as string };
}

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  admin = await person("platform-admin");
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  await db.insert(platformMemberships).values({ userId: admin.user.id, platformRoleId: role!.id, status: "ACTIVE" });
  platformUsers.push(admin.user.id);
  const body = `Termos de TESTE D2-B ${randomUUID()}`;
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`d2b-${randomUUID().slice(0, 8)}`}, 1, 'Termos', ${body}, ${sha(body)}, 'approved', ${admin.user.id}, now(), ${admin.user.id}) returning id`);
  termsId = rows[0]!.id;
  // The Na Pista reconciler identity: PLATFORM_SERVICE / PROVISIONER / credential.provision — created by a PLATFORM_ADMIN.
  const p = await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: ["credential.provision"], purpose: "PROVISIONER" });
  assert.equal(p.status, 201, p.raw);
  provisioner = p.data.secret;
});

after(async () => {
  server.close();
  for (const id of platformUsers) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  for (const id of createdAuthUsers) await db.execute(sql`delete from auth.users where id = ${id}`);
  await queryClient.end();
});

// ---------------------------------------------------------------- happy path

test("happy path: activation → REQUESTED → listed → issue (PENDING) → introspection → confirm → ACTIVE → real calls work", async () => {
  const c = await activeNaPistaContract();
  let pr = await prRow(c.prId);
  assert.deepEqual([pr.status, pr.kind, pr.purpose, pr.issueCount, pr.contractId], ["REQUESTED", "initial", "platform_integration", 0, c.contractId]);

  const listed = await call("GET", "/service/credential-provisionings", provisioner);
  assert.equal(listed.status, 200);
  assert.ok(listed.data.some((r: { id: string; organizationId: string }) => r.id === c.prId && r.organizationId === c.orgId));

  const issued = await issue(c.prId, 0);
  assert.equal(issued.status, 201, issued.raw);
  const token = issued.data.credential.token as string;
  assert.match(token, /^ulk_[0-9a-f-]{36}\./);
  assert.equal(issued.data.credential.status, "PENDING");
  pr = await prRow(c.prId);
  assert.deepEqual([pr.status, pr.issueCount, pr.currentCredentialId], ["ISSUED", 1, issued.data.credential.id]);
  const key = await keyRow(issued.data.credential.id);
  assert.deepEqual([key.credentialClass, key.status, key.organizationId, key.purpose, key.provisioningRequestId, key.createdByUserId], ["INTEGRATION_MANAGED", "PENDING", c.orgId, "platform_integration", c.prId, null]);
  assert.equal(key.secretHash, sha(token.split(".")[1]!), "only the hash is persisted");

  const me = await call("GET", "/service/me", token);
  assert.equal(me.status, 200);
  assert.deepEqual(
    [me.data.credentialClass, me.data.status, me.data.application, me.data.organizationId, me.data.provisioningRequestId, me.data.purpose],
    ["INTEGRATION_MANAGED", "PENDING", "NA_PISTA", c.orgId, c.prId, "platform_integration"],
  );
  assert.deepEqual([...me.data.scopes].sort(), ["event.publish", "usage.write"], "fixed integration scopes, never chosen by the caller");

  const confirmed = await confirm(c.prId, token);
  assert.equal(confirmed.status, 200, confirmed.raw);
  assert.equal(confirmed.data.status, "ACTIVE");
  assert.equal((await keyRow(issued.data.credential.id)).status, "ACTIVE");

  assert.equal((await entitlements(c.orgId, token)).status, 200, "the managed credential reads its organization's entitlements");
  assert.equal((await usage(c.orgId, token)).status, 201, "and records usage");
  assert.equal((await call("GET", "/service/credential-provisionings", provisioner)).data.some((r: { id: string }) => r.id === c.prId), false, "no longer open");

  const actions = (await db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.targetId, c.prId))).map((r) => r.a).sort();
  assert.deepEqual(actions, ["integration.credential.confirmed", "integration.credential.issued", "integration.credential.requested"]);
});

// ---------------------------------------------------------------- security

test("provisioner key rules: PROVISIONER has exactly credential.provision; no other key may hold it", async () => {
  assert.equal((await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: ["credential.provision", "usage.read"], purpose: "PROVISIONER" })).status, 400);
  assert.equal((await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: [], purpose: "PROVISIONER" })).status, 400);
  assert.equal((await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: ["credential.provision"] })).status, 400, "the scope requires the purpose");
  assert.equal((await call("POST", "/platform/credentials", admin.token, { applicationKey: "QUALE_A_DICA", scopes: ["credential.provision"], purpose: "PROVISIONER" })).status, 403, "allow-listed for NA_PISTA only (scope allowlist refusal)");
  const owner = await person("scope-owner");
  const org = await createTestOrganization("d2b-scope", owner.user.id);
  await grantTestApplicationAccess(org.id, "NA_PISTA");
  await assert.rejects(createOrganizationApiKey({ organizationId: org.id, applicationKey: "NA_PISTA", actorUserId: owner.user.id, scopes: ["credential.provision"] }));
});

test("issue authority: JWTs, org keys and ordinary platform keys are refused; unknown or foreign requests do not exist; the body cannot carry authority", async () => {
  const c = await activeNaPistaContract();
  assert.equal((await issue(c.prId, 0, c.owner.token)).status, 403, "OWNER JWT");
  assert.equal((await issue(c.prId, 0, admin.token)).status, 403, "PLATFORM_ADMIN JWT: never receives a managed secret");
  const keyOrg = await createTestOrganization("d2b-keyorg", c.owner.user.id);
  await grantTestApplicationAccess(keyOrg.id, "NA_PISTA");
  const orgKey = await createOrganizationApiKey({ organizationId: keyOrg.id, applicationKey: "NA_PISTA", actorUserId: c.owner.user.id, scopes: ["usage.read"] });
  assert.equal((await issue(c.prId, 0, orgKey.secret)).status, 403, "ORGANIZATION key");
  const plain = await call("POST", "/platform/credentials", admin.token, { applicationKey: "NA_PISTA", scopes: ["usage.read"] });
  assert.equal((await issue(c.prId, 0, plain.data.secret)).status, 403, "PLATFORM_SERVICE without PROVISIONER");
  assert.equal((await call("GET", "/service/credential-provisionings", plain.data.secret)).status, 403);
  assert.equal((await issue(randomUUID(), 0)).status, 404, "no request, no issuance");
  assert.equal((await issue(c.prId, 0, provisioner, { organizationId: keyOrg.id })).status, 400, "organizationId is not accepted");
  assert.equal((await issue(c.prId, 0, provisioner, { applicationId: randomUUID() })).status, 400, "applicationId is not accepted");
  assert.equal((await issue(c.prId, 0, provisioner, { scopes: ["catalog.write"] })).status, 400, "scopes are not accepted");

  // A request of ANOTHER application (inserted directly: no other application has a managed integration yet).
  const [qd] = await db.select().from(applications).where(eq(applications.key, "QUALE_A_DICA"));
  const [foreign] = await db
    .insert(credentialProvisioningRequests)
    .values({ organizationId: c.orgId, applicationId: qd!.id, purpose: "platform_integration", kind: "initial", requestedBy: "test:foreign" })
    .returning();
  assert.equal((await issue(foreign!.id, 0)).status, 404, "the NA_PISTA provisioner cannot see another application's request");
  assert.equal((await call("GET", "/service/credential-provisionings", provisioner)).data.some((r: { id: string }) => r.id === foreign!.id), false);
  assert.equal((await prRow(c.prId)).issueCount, 0, "nothing was issued by any refused attempt");
});

test("a PROVISIONER-purpose key WITHOUT the credential.provision scope cannot list or issue (scope is checked on its own)", async () => {
  const c = await activeNaPistaContract();
  const [na] = await db.select().from(applications).where(eq(applications.key, "NA_PISTA"));
  const scopeless = `d2b-scopeless-${randomUUID()}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ secretHash: sha(scopeless), applicationId: na!.id, organizationId: null, credentialClass: "PLATFORM_SERVICE", purpose: "PROVISIONER" })
    .returning();
  const token = `ulk_${row!.id}.${scopeless}`;
  assert.equal((await call("GET", "/service/credential-provisionings", token)).status, 403);
  assert.equal((await issue(c.prId, 0, token)).status, 403);
  assert.equal((await prRow(c.prId)).issueCount, 0);
});

test("the OWNER never sees, lists or revokes the managed credential through the generic API key routes", async () => {
  const p = await provisioned();
  const list = await call("GET", `/organizations/${p.orgId}/api-keys`, p.owner.token);
  assert.equal(list.status, 200);
  assert.equal(list.data.some((k: { id: string }) => k.id === p.credentialId), false);
  assert.ok(!list.raw.includes("ulk_"));
  assert.equal((await call("GET", `/organizations/${p.orgId}/api-keys/${p.credentialId}`, p.owner.token)).status, 404);
  assert.equal((await call("POST", `/organizations/${p.orgId}/api-keys/${p.credentialId}/revoke`, p.owner.token)).status, 404);
  assert.equal((await keyRow(p.credentialId)).status, "ACTIVE");
  assert.equal((await call("POST", `/platform/credentials/${p.credentialId}/revoke`, admin.token)).status, 404, "nor through the platform-credential route");
});

test("commercial authority at issue: access gone (even without the revocation hook) → refused and the request is cancelled", async () => {
  const c = await activeNaPistaContract();
  // Bypass the hook on purpose: the issuance itself must re-evaluate the authority.
  await db.update(organizationApplicationAccess).set({ status: "revoked", revokedAt: new Date() }).where(eq(organizationApplicationAccess.organizationId, c.orgId));
  const r = await issue(c.prId, 0);
  assert.equal(r.status, 403);
  assert.equal(r.code, "PROVISIONING_NOT_AUTHORIZED");
  assert.equal((await prRow(c.prId)).status, "CANCELLED");
  assert.equal((await db.select().from(apiKeys).where(eq(apiKeys.provisioningRequestId, c.prId))).length, 0, "nothing minted");
});

test("no contractual grant (manual access only) → never authorized", async () => {
  const owner = await person("manual");
  const org = await createTestOrganization("d2b-manual", owner.user.id);
  await grantTestApplicationAccess(org.id, "NA_PISTA");
  const [na] = await db.select().from(applications).where(eq(applications.key, "NA_PISTA"));
  const [pr] = await db.insert(credentialProvisioningRequests).values({ organizationId: org.id, applicationId: na!.id, purpose: "platform_integration", kind: "initial", requestedBy: "test:manual" }).returning();
  const r = await issue(pr!.id, 0);
  assert.equal(r.status, 403);
  assert.match(r.raw, /CONTRACTUAL_GRANT_REQUIRED/);
  assert.equal((await prRow(pr!.id)).status, "CANCELLED");
});

test("a PENDING credential introspects and confirms only — it never calls the application", async () => {
  const c = await activeNaPistaContract();
  const token = (await issue(c.prId, 0)).data.credential.token as string;
  assert.equal((await entitlements(c.orgId, token)).status, 401);
  assert.equal((await usage(c.orgId, token)).status, 401);
  assert.equal((await call("GET", "/service/credential-provisionings", token)).status, 401);
});

test("a revoked managed credential is refused with CREDENTIAL_REVOKED (only after its secret is verified)", async () => {
  const p = await provisioned();
  const r = await call("POST", `/platform/credential-provisionings/${p.prId}/revoke`, admin.token, { reason: "test" });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.status, "REVOKED");
  const e = await entitlements(p.orgId, p.token);
  assert.deepEqual([e.status, e.code], [401, "CREDENTIAL_REVOKED"]);
  assert.equal((await call("GET", "/service/me", p.token)).code, "CREDENTIAL_REVOKED");
  const forged = p.token.replace(/\.[^.]+$/, ".forged-secret");
  assert.equal((await call("GET", "/service/me", forged)).code, "UNAUTHORIZED", "a wrong secret learns nothing");
});

// ---------------------------------------------------------------- retry / concurrency

test("retry: lost before storing → re-issue supersedes the PENDING one; confirm is idempotent; the old one is dead", async () => {
  const c = await activeNaPistaContract();
  const first = (await issue(c.prId, 0)).data.credential;
  assert.equal((await issue(c.prId, 0)).status, 409, "same count twice never mints twice");
  const second = await issue(c.prId, 1);
  assert.equal(second.status, 201);
  assert.equal((await keyRow(first.id)).status, "REVOKED", "superseded_unconfirmed");
  assert.equal((await call("GET", "/service/me", first.token)).status, 401);
  assert.equal((await confirm(c.prId, first.token)).status, 401, "the superseded one cannot confirm");
  const ok1 = await confirm(c.prId, second.data.credential.token);
  const ok2 = await confirm(c.prId, second.data.credential.token);
  assert.deepEqual([ok1.status, ok2.status, ok2.data.status], [200, 200, "ACTIVE"], "duplicate confirm (lost response) converges");
  assert.equal((await prRow(c.prId)).issueCount, 2);
  const reissue = await issue(c.prId, 2);
  assert.deepEqual([reissue.status, reissue.code], [409, "PROVISIONING_NOT_OPEN"], "an ACTIVE request is not re-issued (service check, before the DB guard)");
});

test("confirm accepts only the request's CURRENT pending credential (a stray PENDING key for the same request is refused)", async () => {
  const c = await activeNaPistaContract();
  const current = (await issue(c.prId, 0)).data.credential;
  // A second PENDING key bound to the same request, created behind the service's back (an inconsistent state the service must not trust).
  const [na] = await db.select().from(applications).where(eq(applications.key, "NA_PISTA"));
  const straySecret = `d2b-stray-${randomUUID()}`;
  const [stray] = await db
    .insert(apiKeys)
    .values({ secretHash: sha(straySecret), applicationId: na!.id, organizationId: c.orgId, credentialClass: "INTEGRATION_MANAGED", purpose: "platform_integration", provisioningRequestId: c.prId, status: "PENDING" })
    .returning();
  const r = await confirm(c.prId, `ulk_${stray!.id}.${straySecret}`);
  assert.deepEqual([r.status, r.code], [409, "PROVISIONING_CREDENTIAL_NOT_CURRENT"]);
  assert.equal((await prRow(c.prId)).status, "ISSUED");
  assert.equal((await confirm(c.prId, current.token)).status, 200);
});

test("concurrency: N simultaneous issues for the same count mint exactly one credential", async () => {
  const c = await activeNaPistaContract();
  const results = await Promise.all(Array.from({ length: 12 }, () => issue(c.prId, 0)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 11);
  const keys = await db.select().from(apiKeys).where(eq(apiKeys.provisioningRequestId, c.prId));
  assert.equal(keys.length, 1);
  assert.equal((await prRow(c.prId)).issueCount, 1);
});

test("PENDING window: after 10 minutes it can neither introspect nor confirm; a new issuance replaces it", async () => {
  const c = await activeNaPistaContract();
  const first = (await issue(c.prId, 0)).data.credential;
  await db.update(apiKeys).set({ createdAt: sql`now() - interval '11 minutes'` }).where(eq(apiKeys.id, first.id));
  assert.equal((await call("GET", "/service/me", first.token)).status, 401);
  assert.equal((await confirm(c.prId, first.token)).status, 401);
  const second = (await issue(c.prId, 1)).data.credential;
  assert.equal((await confirm(c.prId, second.token)).status, 200);
});

// ---------------------------------------------------------------- lifecycle

test("contract termination: the managed credential is refused at the next request; request and credential end in the same transaction", async () => {
  const p = await provisioned();
  assert.equal((await entitlements(p.orgId, p.token)).status, 200);
  assert.equal((await call("POST", `/platform/contracts/${p.contractId}/termination`, admin.token)).status, 200);
  const r = await entitlements(p.orgId, p.token);
  assert.equal(r.status, 401);
  assert.equal(r.code, "CREDENTIAL_REVOKED");
  assert.equal((await prRow(p.prId)).status, "REVOKED");
  assert.equal((await keyRow(p.credentialId)).status, "REVOKED");
});

test("application access revocation (platform route) ends the integration atomically", async () => {
  const p = await provisioned();
  const r = await call("DELETE", `/platform/organizations/${p.orgId}/applications/NA_PISTA/access`, admin.token);
  assert.equal(r.status, 200, r.raw);
  assert.equal((await entitlements(p.orgId, p.token)).status, 401);
  assert.equal((await prRow(p.prId)).status, "REVOKED");
});

test("runtime authorization does not depend on stored state: access revoked without the hook → refused at once", async () => {
  const p = await provisioned();
  await db.update(organizationApplicationAccess).set({ status: "revoked", revokedAt: new Date() }).where(eq(organizationApplicationAccess.organizationId, p.orgId));
  const r = await entitlements(p.orgId, p.token);
  assert.deepEqual([r.status, r.code], [403, "CREDENTIAL_NOT_AUTHORIZED"]);
  assert.equal((await keyRow(p.credentialId)).status, "ACTIVE", "existence ≠ authorization");
});

test("grant expiry by time (no job): refused as soon as ends_at passes", async () => {
  const p = await provisioned();
  await db.update(entitlementGrants).set({ startsAt: sql`now() - interval '2 months'`, endsAt: sql`now() - interval '1 minute'` }).where(eq(entitlementGrants.id, p.grantId));
  const r = await entitlements(p.orgId, p.token);
  assert.deepEqual([r.status, r.code], [403, "CREDENTIAL_NOT_AUTHORIZED"]);
  assert.equal((await prRow(p.prId)).status, "ACTIVE", "nothing flipped the stored state — the runtime refused anyway");
});

test("organization suspension refuses the credential while suspended; reactivation restores it (reversible, not revoked)", async () => {
  const p = await provisioned();
  assert.equal((await call("PATCH", `/platform/organizations/${p.orgId}/status`, admin.token, { status: "suspended" })).status, 200);
  const r = await entitlements(p.orgId, p.token);
  assert.deepEqual([r.status, r.code], [403, "ORGANIZATION_SUSPENDED"]);
  assert.equal((await call("PATCH", `/platform/organizations/${p.orgId}/status`, admin.token, { status: "active" })).status, 200);
  assert.equal((await entitlements(p.orgId, p.token)).status, 200);
});

test("rekey (explicit recovery): the predecessor keeps working until the new one is confirmed, then is revoked atomically", async () => {
  const p = await provisioned();
  const rk = await call("POST", `/platform/credential-provisionings/${p.prId}/rekey`, admin.token);
  assert.equal(rk.status, 201, rk.raw);
  assert.equal((await call("POST", `/platform/credential-provisionings/${p.prId}/rekey`, admin.token)).status, 409, "one open request at a time");
  const next = (await issue(rk.data.id, 0)).data.credential;
  assert.equal((await entitlements(p.orgId, p.token)).status, 200, "old still serving");
  assert.equal((await confirm(rk.data.id, next.token)).status, 200);
  assert.equal((await entitlements(p.orgId, p.token)).code, "CREDENTIAL_REVOKED");
  assert.equal((await entitlements(p.orgId, next.token)).status, 200);
  assert.equal((await prRow(p.prId)).status, "SUPERSEDED");
  assert.equal((await call("POST", `/platform/credential-provisionings/${p.prId}/rekey`, p.owner.token)).status, 403, "OWNER cannot");
});

test("ORGANIZATION keys: runtime application access (G6 at use time, not only at creation)", async () => {
  const owner = await person("orgkey");
  const org = await createTestOrganization("d2b-orgkey", owner.user.id);
  await grantTestApplicationAccess(org.id, "NA_PISTA");
  const key = await createOrganizationApiKey({ organizationId: org.id, applicationKey: "NA_PISTA", actorUserId: owner.user.id, scopes: ["usage.write"] });
  assert.equal((await usage(org.id, key.secret)).status, 201);
  assert.equal((await call("GET", "/service/me", key.secret)).data.credentialClass, "ORGANIZATION");
  await db.update(organizationApplicationAccess).set({ status: "revoked", revokedAt: new Date() }).where(eq(organizationApplicationAccess.organizationId, org.id));
  const r = await usage(org.id, key.secret);
  assert.deepEqual([r.status, r.code], [403, "APPLICATION_ACCESS_REQUIRED"]);
});

// ---------------------------------------------------------------- database guards

test("database guards: lifecycle, immutability and uniqueness hold even for direct SQL", async () => {
  const p = await provisioned();
  const fails = async (q: ReturnType<typeof sql>) => assert.rejects(db.execute(q));
  await fails(sql`update credential_provisioning_requests set status = 'REQUESTED' where id = ${p.prId}`);
  await fails(sql`update credential_provisioning_requests set issue_count = 0 where id = ${p.prId}`);
  await fails(sql`update credential_provisioning_requests set organization_id = gen_random_uuid() where id = ${p.prId}`);
  await fails(sql`delete from credential_provisioning_requests where id = ${p.prId}`);
  await fails(sql`update api_keys set credential_class = 'ORGANIZATION', provisioning_request_id = null, purpose = null where id = ${p.credentialId}`);
  await fails(sql`update api_keys set status = 'PENDING' where id = ${p.credentialId}`);
  await fails(sql`insert into credential_provisioning_requests (organization_id, application_id, purpose, kind, requested_by) values (${p.orgId}, (select id from applications where key = 'NA_PISTA'), 'platform_integration', 'initial', 'x'), (${p.orgId}, (select id from applications where key = 'NA_PISTA'), 'platform_integration', 'initial', 'y')`);
  await db.update(apiKeys).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(apiKeys.id, p.credentialId));
  await fails(sql`update api_keys set status = 'ACTIVE', revoked_at = null where id = ${p.credentialId}`);
  await db.execute(sql`update credential_provisioning_requests set status = 'REVOKED' where id = ${p.prId}`);
  await fails(sql`update credential_provisioning_requests set status = 'ACTIVE' where id = ${p.prId}`);
});

// ---------------------------------------------------------------- secret leakage

test("secret leakage: never in logs, audit, other responses or any database column", async () => {
  const writes: string[] = [];
  const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (writes.push(String(chunk)), orig.out(chunk as string, ...(rest as [])))) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (writes.push(String(chunk)), orig.err(chunk as string, ...(rest as [])))) as typeof process.stderr.write;
  let p: Awaited<ReturnType<typeof provisioned>>;
  let other: Res[];
  try {
    p = await provisioned();
    other = [
      await call("GET", "/service/credential-provisionings", provisioner),
      await confirm(p.prId, p.token),
      await call("GET", "/service/me", p.token),
      await call("GET", `/organizations/${p.orgId}/api-keys`, p.owner.token),
      await call("POST", `/platform/credential-provisionings/${p.prId}/revoke`, admin.token, { reason: "leak test" }),
    ];
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  const secretPart = p!.token.split(".")[1]!;
  const hash = sha(secretPart);
  for (const w of writes) {
    assert.ok(!w.includes(secretPart), "secret in a log line");
    assert.ok(!w.includes(hash), "hash in a log line");
  }
  for (const r of other!) assert.ok(!r.raw.includes(secretPart) && !r.raw.includes("ulk_"), "secret in a response other than issue");
  const audit = await db.select({ m: sql<string>`metadata::text` }).from(auditLogs).where(and(eq(auditLogs.organizationId, p!.orgId)));
  assert.ok(audit.length > 0);
  for (const a of audit) assert.ok(!a.m.includes(secretPart) && !a.m.includes(hash) && !a.m.includes("ulk_"), "secret/hash in audit");
  const dump = (await db.execute(sql`select row_to_json(t)::text as j from (select * from api_keys where id = ${p!.credentialId}) t
    union all select row_to_json(t)::text from (select * from credential_provisioning_requests where id = ${p!.prId}) t`)) as unknown as Array<{ j: string }>;
  for (const d of dump) assert.ok(!d.j.includes(secretPart), "plaintext secret in the database");
});
