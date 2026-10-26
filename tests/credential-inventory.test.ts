import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import { apiKeys, auditLogs, platformMemberships, platformPermissions, platformRolePermissions, platformRoles } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createOrganizationApiKey, revokeApiKey } from "../src/modules/apiKeys/service.js";
import { createTestOrganization, createTestUser, grantTestApplicationAccess } from "./helpers.js";

/**
 * Audit 2026-10-23 — GET /v1/platform/credentials/inventory over HTTP against the disposable test database: real
 * platform roles, real API keys. Authorization, no secret material, masking, filters, keyset pagination, audit row,
 * and a constant number of database round trips per request whatever the page size.
 */
const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const tokenFor = (user: { id: string; email: string }) =>
  new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setIssuer(EXPECTED_ISSUER).setExpirationTime("10m").sign(secret);

async function get(path: string, token?: string) {
  const res = await fetch(base() + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : null;
  return { status: res.status, data: json?.data, code: json?.error?.code, raw };
}

const roleIds: string[] = [];
const userIds: string[] = [];
let admin: string;
let otherPlatformRole: string;
let plain: string;
let orgId: string;
const secrets: string[] = [];
const keyIds: Record<string, string> = {};
let ownerId: string;

before(async () => {
  await seed();
  const [adminRole] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  const platformUser = async (roleId: string | null) => {
    const user = await createTestUser("inv");
    userIds.push(user.id);
    if (roleId) await db.insert(platformMemberships).values({ userId: user.id, platformRoleId: roleId, status: "ACTIVE" });
    return tokenFor({ id: user.id, email: user.email });
  };
  admin = await platformUser(adminRole!.id);
  // A platform member WITHOUT platform.credential.read.
  const [role] = await db.insert(platformRoles).values({ key: `TEST_INV_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test inventory role" }).returning();
  roleIds.push(role!.id);
  const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, "platform.commercial.read"));
  await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  otherPlatformRole = await platformUser(role!.id);
  plain = await platformUser(null);

  const owner = await createTestUser("inv-owner");
  ownerId = owner.id;
  const org = await createTestOrganization("inv-org", owner.id);
  orgId = org.id;
  await grantTestApplicationAccess(org.id, "NA_PISTA");
  await grantTestApplicationAccess(org.id, "QUALE_A_DICA");
  const mint = async (label: string, applicationKey: string, scopes: string[]) => {
    const k = await createOrganizationApiKey({ organizationId: org.id, applicationKey, scopes, actorUserId: owner.id });
    secrets.push(k.secret);
    keyIds[label] = k.id;
  };
  await mint("naPista", "NA_PISTA", ["catalog.read", "customer.read"]);
  await mint("qd", "QUALE_A_DICA", ["catalog.read"]);
  await mint("expired", "NA_PISTA", ["catalog.write"]);
  await mint("revoked", "NA_PISTA", ["order.read"]);
  await db.update(apiKeys).set({ expiresAt: sql`now() - interval '1 day'` }).where(eq(apiKeys.id, keyIds.expired!));
  await revokeApiKey({ organizationId: org.id, keyId: keyIds.revoked!, actorUserId: owner.id });
});

after(async () => {
  // Leave no platform administrator behind: other suites (platform-administration) require none to exist.
  for (const id of userIds) await db.delete(platformMemberships).where(eq(platformMemberships.userId, id));
  for (const id of roleIds) await db.delete(platformRoles).where(eq(platformRoles.id, id)).catch(() => undefined);
  server.close();
  await queryClient.end();
});

test("authorization: PLATFORM_ADMIN 200; platform member without platform.credential.read 403; plain user 403; service key 403; anonymous 401", async () => {
  assert.equal((await get(`/platform/credentials/inventory?organizationId=${orgId}`, admin)).status, 200);
  assert.equal((await get("/platform/credentials/inventory", otherPlatformRole)).status, 403);
  assert.equal((await get("/platform/credentials/inventory", plain)).status, 403);
  assert.equal((await get("/platform/credentials/inventory", secrets[0])).status, 403);
  assert.equal((await get("/platform/credentials/inventory")).status, 401);
});

test("no secret material: no token, no secret hash, no full key id anywhere in the response; ids masked", async () => {
  const r = await get(`/platform/credentials/inventory?organizationId=${orgId}`, admin);
  const hashes = (await db.select({ h: apiKeys.secretHash }).from(apiKeys).where(eq(apiKeys.organizationId, orgId))).map((x) => x.h);
  for (const s of secrets) assert.ok(!r.raw.includes(s) && !r.raw.includes(s.split(".")[1]!), "no token or secret");
  for (const h of hashes) assert.ok(!r.raw.includes(h), "no secret hash");
  for (const id of Object.values(keyIds)) assert.ok(!r.raw.includes(id), "no full key id");
  assert.ok(!/secret/i.test(Object.keys(r.data.items[0]).join(",")));
  for (const item of r.data.items) assert.match(item.keyIdPrefix, /^[0-9a-f]{8}…$/);
});

test("facts and gaps: application, class, effective status, scopes, the organization's active applications; consumer/lastUsedAt stated as not recorded", async () => {
  const r = await get(`/platform/credentials/inventory?organizationId=${orgId}`, admin);
  assert.equal(r.data.items.length, 4);
  const byPrefix = new Map(r.data.items.map((i: { keyIdPrefix: string }) => [i.keyIdPrefix, i]));
  const item = (label: string) => byPrefix.get(`${keyIds[label]!.slice(0, 8)}…`) as Record<string, unknown> & { organization: { activeApplications: string[] } };
  assert.deepEqual([item("qd").application, item("qd").credentialClass, item("qd").status, item("qd").scopes], ["QUALE_A_DICA", "ORGANIZATION", "ACTIVE", ["catalog.read"]]);
  assert.deepEqual(item("naPista").scopes, ["catalog.read", "customer.read"]);
  assert.equal(item("expired").status, "EXPIRED");
  assert.equal(item("revoked").status, "REVOKED");
  assert.deepEqual(item("qd").organization.activeApplications, ["NA_PISTA", "QUALE_A_DICA"]);
  assert.equal(item("qd").consumer, null);
  assert.equal(item("qd").lastUsedAt, null);
  assert.ok(r.data.knowledge.notRecorded.consumer && r.data.knowledge.notRecorded.lastUsedAt && r.data.knowledge.undeterminable);
});

test("filters: application, scope, status, class; the exposure query (another application holding catalog.read) finds exactly the QD key", async () => {
  const q = (s: string) => get(`/platform/credentials/inventory?organizationId=${orgId}&${s}`, admin).then((r) => r.data.items.map((i: { keyIdPrefix: string }) => i.keyIdPrefix));
  const p = (label: string) => `${keyIds[label]!.slice(0, 8)}…`;
  assert.deepEqual(await q("applicationKey=QUALE_A_DICA"), [p("qd")]);
  assert.deepEqual((await q("scope=catalog.read")).sort(), [p("naPista"), p("qd")].sort());
  assert.deepEqual(await q("status=EXPIRED"), [p("expired")]);
  assert.deepEqual(await q("status=REVOKED"), [p("revoked")]);
  assert.equal((await q("status=ACTIVE")).length, 2);
  assert.equal((await q("credentialClass=PLATFORM_SERVICE")).length, 0);
  assert.deepEqual(await q("applicationKey=QUALE_A_DICA&scope=catalog.read&status=ACTIVE"), [p("qd")]);
  assert.equal((await get("/platform/credentials/inventory?scope=DROP TABLE", admin)).status, 400);
  assert.equal((await get("/platform/credentials/inventory?unknown=1", admin)).status, 400);
  assert.equal((await get("/platform/credentials/inventory?limit=1000", admin)).status, 400);
});

test("keyset pagination: limit=1 walks the 4 keys once each, newest first, then nextCursor is null", async () => {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await get(`/platform/credentials/inventory?organizationId=${orgId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, admin);
    assert.equal(r.status, 200);
    seen.push(...r.data.items.map((x: { keyIdPrefix: string }) => x.keyIdPrefix));
    cursor = r.data.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
  assert.equal((await get("/platform/credentials/inventory?cursor=garbage", admin)).status, 400);
});

test("each read is audited (actor, filters, count) without secrets", async () => {
  await get(`/platform/credentials/inventory?organizationId=${orgId}&applicationKey=QUALE_A_DICA`, admin);
  const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "platform.credential.inventory_read"), sql`${auditLogs.metadata}->'filters'->>'applicationKey' = 'QUALE_A_DICA'`));
  assert.ok(rows.length >= 1);
  const last = rows.at(-1)!;
  assert.equal((last.metadata as { returned: number }).returned, 1);
  for (const s of secrets) assert.ok(!JSON.stringify(last).includes(s.split(".")[1]!));
});

test("constant database round trips per request, whatever the page size (no N+1)", async () => {
  const client = queryClient as unknown as { unsafe: (...a: unknown[]) => unknown };
  const original = client.unsafe;
  let n = 0;
  client.unsafe = function (this: unknown, ...a: unknown[]) {
    n++;
    return original.apply(this, a);
  };
  const count = async (limit: number) => {
    await get(`/platform/credentials/inventory?organizationId=${orgId}&limit=${limit}`, admin); // warm per-user lookups
    n = 0;
    await get(`/platform/credentials/inventory?organizationId=${orgId}&limit=${limit}`, admin);
    return n;
  };
  try {
    const one = await count(1);
    const four = await count(4);
    assert.equal(four, one, `round trips with 1 item (${one}) and 4 items (${four}) must be equal`);
    console.log(`[inventory] database round trips per request (auth + inventory + audit): ${one}`);
  } finally {
    client.unsafe = original;
  }
  void ownerId;
});
