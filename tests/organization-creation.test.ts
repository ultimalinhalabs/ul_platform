import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import {
  auditLogs,
  contracts,
  entitlementGrants,
  memberships,
  organizationApplicationAccess,
  organizationCreationRequests,
  organizations,
  roles,
  subscriptions,
  users,
} from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { slugSuffix } from "../src/modules/organizations/service.js";
import { createTestUser, deleteTestUser } from "./helpers.js";

/**
 * POST /v1/organizations over HTTP: verified email required (403
 * EMAIL_NOT_VERIFIED), Idempotency-Key replay/conflict, concurrent double
 * submission, repeated names, the per-user window and the burst limiter,
 * and that creation grants OWNER only — no access, subscription or contract.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const createdUsers: string[] = [];

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
}

async function create(token: string | undefined, body: unknown, idempotencyKey?: string) {
  const res = await fetch(`${base()}/organizations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: { id: string; name: string; slug: string; createdBy: string }; error?: { code?: string } } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code, replayed: res.headers.get("idempotent-replayed") };
}

/** A platform user signed in through the API, with a verified (or unverified) email in auth.users. */
async function signedIn(prefix: string, opts: { verified?: boolean } = {}) {
  const user = await createTestUser(prefix);
  createdUsers.push(user.id);
  await db.execute(sql`insert into auth.users (id, email_confirmed_at) values (${user.id}, ${opts.verified === false ? null : sql`now()`})`);
  return { user, token: await tokenFor(user) };
}

const newKey = () => `org-create-${randomUUID()}`;

async function organizationsCreatedBy(userId: string) {
  return db.select().from(organizations).where(eq(organizations.createdBy, userId));
}

before(async () => {
  await seed();
  // A Supabase project has auth.users; disposable/CI databases don't — provide the minimal shape.
  await db.execute(sql`create schema if not exists auth`);
  await db.execute(sql`create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)`);
});

after(async () => {
  server.close();
  if (createdUsers.length > 0) {
    await db.delete(organizations).where(inArray(organizations.createdBy, createdUsers));
    await db.execute(sql`delete from auth.users where id in ${createdUsers}`);
  }
  for (const id of createdUsers) await deleteTestUser(id);
  await queryClient.end();
});

test("an unverified email is refused with 403 EMAIL_NOT_VERIFIED and nothing is created", async () => {
  const { user, token } = await signedIn("org-unverified", { verified: false });
  const r = await create(token, { name: "Sem Verificação" }, newKey());
  assert.equal(r.status, 403);
  assert.equal(r.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await organizationsCreatedBy(user.id)).length, 0);
});

test("a user absent from auth.users (identity provider never confirmed it) is refused", async () => {
  const user = await createTestUser("org-no-auth-row");
  createdUsers.push(user.id);
  const r = await create(await tokenFor(user), { name: "Sem Registo Auth" }, newKey());
  assert.equal(r.status, 403);
  assert.equal(r.code, "EMAIL_NOT_VERIFIED");
});

test("no token ⇒ 401; a missing or malformed Idempotency-Key ⇒ 400, nothing created", async () => {
  assert.equal((await create(undefined, { name: "Anónimo" }, newKey())).status, 401);
  const { user, token } = await signedIn("org-key");
  const missing = await create(token, { name: "Sem Chave" });
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "VALIDATION_ERROR");
  assert.equal((await create(token, { name: "Chave Curta" }, "short")).status, 400);
  assert.equal((await create(token, { name: "Chave Inválida" }, "has spaces in it!")).status, 400);
  assert.equal((await create(token, { name: "   " }, newKey())).status, 400, "a blank name after trimming is invalid");
  assert.equal((await organizationsCreatedBy(user.id)).length, 0);
});

test("a disabled account is refused before anything is created", async () => {
  const { user, token } = await signedIn("org-disabled");
  await db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
  const r = await create(token, { name: "Conta Desactivada" }, newKey());
  assert.equal(r.status, 403);
  assert.equal(r.code, "ACCOUNT_DISABLED");
  assert.equal((await organizationsCreatedBy(user.id)).length, 0);
});

test("a verified user creates the organization and becomes its active OWNER — nothing else is granted", async () => {
  const { user, token } = await signedIn("org-create");
  const r = await create(token, { name: "  Mercearia Kilamba  " }, newKey());
  assert.equal(r.status, 201);
  assert.equal(r.replayed, null);
  const org = r.data!;
  assert.equal(org.name, "Mercearia Kilamba", "name is trimmed");
  assert.equal(org.createdBy, user.id);
  assert.match(org.slug, /^mercearia-kilamba-[0-9a-f]{6}$/);

  const owners = await db
    .select({ userId: memberships.userId, status: memberships.status, roleKey: roles.key })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.organizationId, org.id));
  assert.deepEqual(owners, [{ userId: user.id, status: "active", roleKey: "OWNER" }]);

  const [audit] = await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.action, "organization.created"), eq(auditLogs.targetId, org.id)));
  assert.equal(audit!.n, 1);

  // No application access, subscription, entitlement grant or contract comes with a new organization.
  for (const [label, table] of [
    ["application access", organizationApplicationAccess],
    ["subscriptions", subscriptions],
    ["entitlement grants", entitlementGrants],
    ["contracts", contracts],
  ] as const) {
    const [row] = await db.select({ n: count() }).from(table).where(eq(table.organizationId, org.id));
    assert.equal(row!.n, 0, `no ${label}`);
  }

  const me = await fetch(`${base()}/me`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json() as Promise<{ data: { memberships: Array<{ organizationId: string; roleKey: string; applications: unknown[] }> } }>);
  const membership = me.data.memberships.find((m) => m.organizationId === org.id);
  assert.equal(membership?.roleKey, "OWNER");
  assert.deepEqual(membership?.applications, []);
});

test("the same Idempotency-Key and body replays the original organization (200), never a second one", async () => {
  const { user, token } = await signedIn("org-replay");
  const key = newKey();
  const first = await create(token, { name: "Padaria Talatona" }, key);
  assert.equal(first.status, 201);
  const again = await create(token, { name: "Padaria Talatona" }, key);
  assert.equal(again.status, 200);
  assert.equal(again.replayed, "true");
  assert.equal(again.data!.id, first.data!.id);
  const trimmed = await create(token, { name: " Padaria Talatona " }, key);
  assert.equal(trimmed.status, 200, "surrounding whitespace is the same request");
  assert.equal(trimmed.data!.id, first.data!.id);
  assert.equal((await organizationsCreatedBy(user.id)).length, 1);
});

test("the same Idempotency-Key with a different body is a 409 — no overwrite, no second organization", async () => {
  const { user, token } = await signedIn("org-key-conflict");
  const key = newKey();
  const first = await create(token, { name: "Oficina Viana" }, key);
  assert.equal(first.status, 201);
  const conflict = await create(token, { name: "Outra Empresa" }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, "CONFLICT");
  const orgs = await organizationsCreatedBy(user.id);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0]!.name, "Oficina Viana");
});

test("an Idempotency-Key is scoped to its user: another user's identical key creates their own organization", async () => {
  const a = await signedIn("org-key-a");
  const b = await signedIn("org-key-b");
  const key = newKey();
  const ra = await create(a.token, { name: "Mesma Chave" }, key);
  const rb = await create(b.token, { name: "Mesma Chave" }, key);
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.data!.id, rb.data!.id);
  assert.equal(rb.data!.createdBy, b.user.id);
});

test("a concurrent double submission with one key creates exactly one organization", async () => {
  const { user, token } = await signedIn("org-concurrent");
  const key = newKey();
  const results = await Promise.all(Array.from({ length: 5 }, () => create(token, { name: "Duplo Clique" }, key)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.data!.id)).size, 1);
  assert.equal((await organizationsCreatedBy(user.id)).length, 1);
  const [requests] = await db.select({ n: count() }).from(organizationCreationRequests).where(eq(organizationCreationRequests.userId, user.id));
  assert.equal(requests!.n, 1);
});

test("organizations with the same name (different keys, different users) all succeed with distinct slugs", async () => {
  const a = await signedIn("org-same-name-a");
  const b = await signedIn("org-same-name-b");
  const results = [
    await create(a.token, { name: "Restaurante Ilha" }, newKey()),
    await create(a.token, { name: "Restaurante Ilha" }, newKey()),
    await create(b.token, { name: "Restaurante Ilha" }, newKey()),
  ];
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
  assert.equal(new Set(results.map((r) => r.data!.slug)).size, 3);
});

test("an explicitly chosen slug that is already taken is a 409, and nothing is half-created", async () => {
  const a = await signedIn("org-slug-a");
  const b = await signedIn("org-slug-b");
  const slug = `slug-escolhido-${randomUUID().slice(0, 8)}`;
  assert.equal((await create(a.token, { name: "Primeira", slug }, newKey())).status, 201);
  const taken = await create(b.token, { name: "Segunda", slug }, newKey());
  assert.equal(taken.status, 409);
  assert.equal((await organizationsCreatedBy(b.user.id)).length, 0);
  const [requests] = await db.select({ n: count() }).from(organizationCreationRequests).where(eq(organizationCreationRequests.userId, b.user.id));
  assert.equal(requests!.n, 0);
});

test("the per-user 24h window (ORGANIZATION_CREATION_DAILY_LIMIT) refuses with 429 but still answers replays", async () => {
  const previous = env.ORGANIZATION_CREATION_DAILY_LIMIT;
  env.ORGANIZATION_CREATION_DAILY_LIMIT = 2;
  try {
    const { user, token } = await signedIn("org-window");
    const firstKey = newKey();
    assert.equal((await create(token, { name: "Janela 1" }, firstKey)).status, 201);
    assert.equal((await create(token, { name: "Janela 2" }, newKey())).status, 201);
    const third = await create(token, { name: "Janela 3" }, newKey());
    assert.equal(third.status, 429);
    assert.equal(third.code, "ORGANIZATION_CREATION_LIMIT");
    assert.equal((await create(token, { name: "Janela 1" }, firstKey)).status, 200, "a replay is not a new creation");
    assert.equal((await organizationsCreatedBy(user.id)).length, 2);

    // Another user is unaffected by this user's window.
    const other = await signedIn("org-window-other");
    assert.equal((await create(other.token, { name: "Outro Utilizador" }, newKey())).status, 201);
  } finally {
    env.ORGANIZATION_CREATION_DAILY_LIMIT = previous;
  }
});

/** Organizations "created" by the user at a given age — fixtures for the rolling window, without spending the burst limiter. */
async function priorOrganizations(userId: string, n: number, ageSql = sql`now()`) {
  for (let i = 0; i < n; i++) {
    const slug = `janela-previa-${randomUUID()}`;
    await db.insert(organizations).values({ name: slug, slug, createdBy: userId, createdAt: ageSql as unknown as Date });
  }
}

test("the default window is 10 organizations per user per rolling 24 h: the 11th is refused", async () => {
  assert.equal(env.ORGANIZATION_CREATION_DAILY_LIMIT, 10, "owner's initial proposal (2026-10-15)");
  const { user, token } = await signedIn("org-window-default");
  await priorOrganizations(user.id, 9);
  assert.equal((await create(token, { name: "Décima" }, newKey())).status, 201);
  const eleventh = await create(token, { name: "Décima Primeira" }, newKey());
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.code, "ORGANIZATION_CREATION_LIMIT");
  assert.equal((await organizationsCreatedBy(user.id)).length, 10);
});

test("the window is rolling: organizations created more than 24 h ago do not count", async () => {
  const { user, token } = await signedIn("org-window-rolling");
  await priorOrganizations(user.id, 10, sql`now() - interval '25 hours'`);
  assert.equal((await create(token, { name: "Depois da Janela" }, newKey())).status, 201);
  await priorOrganizations(user.id, 9, sql`now() - interval '23 hours'`);
  assert.equal((await create(token, { name: "Dentro da Janela" }, newKey())).status, 429);
});

test("ORGANIZATION_CREATION_DAILY_LIMIT=0 disables the window", async () => {
  const previous = env.ORGANIZATION_CREATION_DAILY_LIMIT;
  env.ORGANIZATION_CREATION_DAILY_LIMIT = 0;
  try {
    const { user, token } = await signedIn("org-window-off");
    await priorOrganizations(user.id, 12);
    assert.equal((await create(token, { name: "Sem Janela" }, newKey())).status, 201);
    assert.equal((await organizationsCreatedBy(user.id)).length, 13);
  } finally {
    env.ORGANIZATION_CREATION_DAILY_LIMIT = previous;
  }
});

test("a generated slug that collides is retried with a new suffix — the organization is still created", async (t) => {
  const { user, token } = await signedIn("org-slug-collision");
  const taken = `colisao-${randomUUID().slice(0, 6)}`;
  await db.insert(organizations).values({ name: "Ocupada", slug: `colisao-forcada-${taken}`, createdBy: null });
  const suffixes = [taken, taken, "livre1"];
  t.mock.method(slugSuffix, "next", () => suffixes.shift() ?? "livre2");
  const r = await create(token, { name: "Colisão Forçada" }, newKey());
  assert.equal(r.status, 201, "two collisions, recovered on the third attempt");
  assert.equal(r.data!.slug, "colisao-forcada-livre1");
  assert.equal((await organizationsCreatedBy(user.id)).length, 1);
  await db.delete(organizations).where(eq(organizations.slug, `colisao-forcada-${taken}`));
});

test("when every slug attempt collides, nothing is half-created and the key stays free for a retry", async (t) => {
  const { user, token } = await signedIn("org-slug-exhausted");
  const taken = `esgotado-${randomUUID().slice(0, 6)}`;
  await db.insert(organizations).values({ name: "Ocupada", slug: `sem-saida-${taken}`, createdBy: null });
  const key = newKey();
  const mocked = t.mock.method(slugSuffix, "next", () => taken);
  const r = await create(token, { name: "Sem Saída" }, key);
  assert.equal(r.status, 500);
  assert.equal(mocked.mock.callCount(), 5, "bounded retries");
  assert.equal((await organizationsCreatedBy(user.id)).length, 0);
  const [requests] = await db.select({ n: count() }).from(organizationCreationRequests).where(eq(organizationCreationRequests.userId, user.id));
  assert.equal(requests!.n, 0);
  mocked.mock.restore();
  const retry = await create(token, { name: "Sem Saída" }, key);
  assert.equal(retry.status, 201, "the same key succeeds once a free slug exists");
  await db.delete(organizations).where(eq(organizations.slug, `sem-saida-${taken}`));
});

test("a burst of more than 10 requests in 10 minutes from one user is refused with 429 RATE_LIMITED", async () => {
  const { user, token } = await signedIn("org-burst");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await create(token, { name: "Rajada" }, "bad key")).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
  assert.equal(statuses[10], 429);
  assert.equal((await organizationsCreatedBy(user.id)).length, 0);
});

test("CORS: a browser preflight from an allowed origin may send Idempotency-Key", async () => {
  const origin = env.PLATFORM_ALLOWED_ORIGINS[0]!;
  const res = await fetch(`${base()}/organizations`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,idempotency-key" },
  });
  assert.ok(res.status === 204 || res.status === 200);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /idempotency-key/i);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
});
