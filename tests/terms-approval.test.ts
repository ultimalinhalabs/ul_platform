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
  platformMemberships,
  platformPermissions,
  platformRolePermissions,
  platformRoles,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { createTestUser } from "./helpers.js";

/**
 * Terms approval from the UL Console (owner decision 2026-10-18, migration 0030) — over HTTP against the disposable
 * test database, real JWTs and platform roles: who may approve, exact-text hash, draft markers, event + audit, freeze.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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

const createdAuthUsers: string[] = [];
const platformUsers: string[] = [];
const testRoleIds: string[] = [];

async function person(prefix: string) {
  const user = await createTestUser(`tap-${prefix}`);
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
  const [role] = await db.insert(platformRoles).values({ key: `TEST_TAP_${randomBytes(3).toString("hex").toUpperCase()}`, name: "Test PCR role" }).returning();
  testRoleIds.push(role!.id);
  for (const key of permissionKeys) {
    const [perm] = await db.select().from(platformPermissions).where(eq(platformPermissions.key, key));
    await db.insert(platformRolePermissions).values({ platformRoleId: role!.id, platformPermissionId: perm!.id });
  }
  return role!.id;
}

let admin: { user: User; token: string };
let readOnly: { user: User; token: string };
let financeLike: { user: User; token: string };

async function draftTerms(text: string) {
  const rows = await db.execute<{ id: string }>(sql`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, created_by)
    values (${`tap-${randomUUID().slice(0, 8)}`}, 1, 'Termos TAP', ${text}, ${sha(text)}, 'draft', ${admin.user.id}) returning id`);
  return rows[0]!.id;
}

before(async () => {
  await seed();
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
  const [adminRole] = await db.select().from(platformRoles).where(eq(platformRoles.key, "PLATFORM_ADMIN"));
  admin = await platformPersonWithRole(adminRole!.id, "admin");
  readOnly = await platformPersonWithRole(await testPlatformRole(["platform.commercial.read"]), "readonly");
  financeLike = await platformPersonWithRole(await testPlatformRole(["platform.commercial.read", "platform.payment.confirm"]), "finance");
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

test("migration 0030 / seed: PLATFORM_ADMIN holds platform.terms.approve", async () => {
  const rows = await db.execute<{ n: number }>(sql`select count(*)::int n from platform_role_permissions rp join platform_roles r on r.id = rp.platform_role_id join platform_permissions p on p.id = rp.platform_permission_id where r.key = 'PLATFORM_ADMIN' and p.key = 'platform.terms.approve'`);
  assert.equal(rows[0]!.n, 1);
});

test("the full text is readable (platform.commercial.read) with its hash and draft markers", async () => {
  const text = `Termos finais TAP ${randomUUID()}`;
  const id = await draftTerms(text);
  const r = await call("GET", `/platform/commercial/terms/${id}`, readOnly.token);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.body, text);
  assert.equal(r.data.contentSha256, sha(text));
  assert.deepEqual(r.data.draftMarkers, []);
  assert.equal(r.data.status, "draft");
  assert.equal((await call("GET", `/platform/commercial/terms/${randomUUID()}`, readOnly.token)).status, 404);
  assert.equal((await call("GET", `/platform/commercial/terms/not-a-uuid`, readOnly.token)).status, 400);
});

test("approval: only with platform.terms.approve; anonymous 401; read-only / finance 403", async () => {
  const text = `Termos TAP auth ${randomUUID()}`;
  const id = await draftTerms(text);
  const body = { contentSha256: sha(text) };
  assert.equal((await call("POST", `/platform/commercial/terms/${id}/approve`, undefined, body)).status, 401);
  assert.equal((await call("POST", `/platform/commercial/terms/${id}/approve`, readOnly.token, body)).status, 403);
  assert.equal((await call("POST", `/platform/commercial/terms/${id}/approve`, financeLike.token, body)).status, 403);
  const [row] = await db.execute<{ status: string }>(sql`select status from commercial_terms_templates where id = ${id}`);
  assert.equal(row!.status, "draft");
});

test("approval records who/when, an event and an audit entry; it is idempotent and the text is then frozen", async () => {
  const text = `Termos TAP ok ${randomUUID()}`;
  const id = await draftTerms(text);
  const r = await call("POST", `/platform/commercial/terms/${id}/approve`, admin.token, { contentSha256: sha(text) });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.data.replayed, false);
  assert.equal(r.data.terms.status, "approved");
  assert.equal(r.data.terms.approvedBy, admin.user.id);
  const again = await call("POST", `/platform/commercial/terms/${id}/approve`, admin.token, { contentSha256: sha(text) });
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  const ev = await db.execute<{ n: number }>(sql`select count(*)::int n from commercial_events where aggregate_id = ${id} and event_type = 'terms.approved'`);
  assert.equal(ev[0]!.n, 1);
  const au = await db.execute<{ n: number }>(sql`select count(*)::int n from audit_logs where target_id = ${id} and action = 'platform.terms.approved'`);
  assert.equal(au[0]!.n, 1);
  await assert.rejects(db.execute(sql`update commercial_terms_templates set body = 'x' where id = ${id}`));
});

test("approval refuses a stale hash (TERMS_CHANGED) and a text with draft markers (TERMS_HAVE_DRAFT_MARKERS)", async () => {
  const text = `Termos TAP stale ${randomUUID()}`;
  const id = await draftTerms(text);
  const stale = await call("POST", `/platform/commercial/terms/${id}/approve`, admin.token, { contentSha256: sha("outro texto") });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "TERMS_CHANGED");
  const draftText = `RASCUNHO — Termos TAP ${randomUUID()}`;
  const id2 = await draftTerms(draftText);
  const marked = await call("POST", `/platform/commercial/terms/${id2}/approve`, admin.token, { contentSha256: sha(draftText) });
  assert.equal(marked.status, 409);
  assert.equal(marked.code, "TERMS_HAVE_DRAFT_MARKERS");
  assert.equal((await call("POST", `/platform/commercial/terms/${id}/approve`, admin.token, { contentSha256: "zz" })).status, 400);
});
