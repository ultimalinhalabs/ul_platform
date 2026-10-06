import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { db, queryClient } from "../src/db/index.js";
import { memberships, roles, subscriptions } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { EXPECTED_ISSUER } from "../src/integrations/supabase/jwt.js";
import { isSelfServicePlan, SELF_SERVICE_PLANS } from "../src/modules/subscriptions/selfService.js";
import { createSubscription } from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

/**
 * Block 0 — commercial authority: an OWNER can no longer self-subscribe to a
 * contractual plan over HTTP; the service the commercial flow will use, reads
 * and cancellation keep working.
 */

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

async function tokenFor(user: { id: string; email: string }) {
  return new SignJWT({ email: user.email, aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(base() + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code?: string } } | null;
  return { status: res.status, data: json?.data, code: json?.error?.code };
}

async function ownerWithOrganization(prefix: string) {
  const owner = await createTestUser(prefix);
  createdUsers.push(owner.id);
  const organization = await createTestOrganization(prefix, owner.id);
  createdOrgs.push(organization.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.id, organizationId: organization.id, roleId: ownerRole!.id, status: "active" });
  return { owner, organization, token: await tokenFor(owner) };
}

before(async () => {
  await seed();
});

after(async () => {
  server.close();
  for (const id of createdOrgs) await deleteTestOrganization(id);
  for (const id of createdUsers) await deleteTestUser(id);
  await queryClient.end();
});

test("every plan is contractual by default; only an explicit APPLICATION/PLAN entry is self-service", () => {
  assert.equal(SELF_SERVICE_PLANS.size, 0);
  assert.equal(isSelfServicePlan("NA_PISTA", "BUSINESS"), false);
  assert.equal(isSelfServicePlan("NA_PISTA", "STARTER"), false);
  assert.equal(isSelfServicePlan("NA_PISTA", "STARTER", new Set(["NA_PISTA/STARTER"])), true);
  assert.equal(isSelfServicePlan("NA_PISTA", "BUSINESS", new Set(["NA_PISTA/STARTER"])), false);
});

test("an OWNER cannot self-subscribe to a contractual plan over HTTP, and nothing is created", async () => {
  const { organization, token } = await ownerWithOrganization("b0-self-service");
  for (const planKey of ["STARTER", "BUSINESS"]) {
    const res = await call("POST", `/organizations/${organization.id}/subscriptions`, token, { applicationKey: "NA_PISTA", planKey });
    assert.equal(res.status, 403);
    assert.equal(res.code, "PLAN_REQUIRES_CONTRACT");
  }
  const rows = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.organizationId, organization.id));
  assert.equal(rows.length, 0);
});

test("the commercial path (service) still creates subscriptions; reads and cancellation stay available to the OWNER", async () => {
  const { owner, organization, token } = await ownerWithOrganization("b0-contractual");
  const created = await createSubscription({ organizationId: organization.id, applicationKey: "NA_PISTA", planKey: "BUSINESS", actorUserId: owner.id });

  const list = await call("GET", `/organizations/${organization.id}/subscriptions`, token);
  assert.equal(list.status, 200);
  assert.equal((list.data as Array<{ id: string }>).length, 1);

  const cancel = await call("PATCH", `/organizations/${organization.id}/subscriptions/${created.id}`, token, { status: "canceled" });
  assert.equal(cancel.status, 200);
  const [row] = await db.select({ status: subscriptions.status }).from(subscriptions).where(and(eq(subscriptions.id, created.id), eq(subscriptions.organizationId, organization.id)));
  assert.equal(row!.status, "canceled");
});
