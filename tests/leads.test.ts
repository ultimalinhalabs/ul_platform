import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { db, queryClient } from "../src/db/index.js";
import { auditLogs, commercialLeads } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { createOrganizationApiKey, createPlatformApiKey } from "../src/modules/apiKeys/service.js";
import { ForbiddenError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, grantTestApplicationAccess } from "./helpers.js";

/**
 * Lead intake (`POST /v1/service/leads`) over HTTP on the disposable test database: only a
 * UL_LANDING PLATFORM_SERVICE credential with `lead.create` may write; Idempotency-Key replays
 * resolve to the original lead; responses and audit rows carry no personal data.
 */

const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

type Res = { status: number; data: ReturnType<typeof JSON.parse>; code?: string; raw: string };

async function postLead(token: string | undefined, body: unknown, idempotencyKey?: string): Promise<Res> {
  const res = await fetch(`${base()}/service/leads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : null;
  return { status: res.status, data: json?.data, code: json?.error?.code, raw };
}

const MARK = `lead-${randomUUID().slice(0, 8)}`;
const lead = (overrides: Record<string, unknown> = {}) => ({
  companyName: `Empresa ${MARK}`,
  contactName: "Contacto Teste",
  email: `${MARK}@Example.TEST`,
  phone: "+244 923 000 000",
  businessArea: "Testes",
  desiredService: "Validação",
  message: "Mensagem de teste com mais de dez caracteres.",
  landingPage: "https://www.ultimalinha.ao/",
  utm: { source: "google", campaign: "teste" },
  userAgent: "node-test",
  ...overrides,
});

let landingToken: string;
let landingNoScopeToken: string;
let orgToken: string;
let orgId: string;
const createdLeadIds: string[] = [];

before(async () => {
  await seed();
  const actor = await createTestUser("leads-actor");
  landingToken = (await createPlatformApiKey({ applicationKey: "UL_LANDING", actorUserId: actor.id, scopes: ["lead.create"] })).secret;
  landingNoScopeToken = (await createPlatformApiKey({ applicationKey: "UL_LANDING", actorUserId: actor.id })).secret;
  const org = await createTestOrganization("leads-org", actor.id);
  orgId = org.id;
  await grantTestApplicationAccess(org.id, "NA_PISTA");
  orgToken = (await createOrganizationApiKey({ organizationId: org.id, applicationKey: "NA_PISTA", actorUserId: actor.id, scopes: ["event.publish"] })).secret;
});

after(async () => {
  if (createdLeadIds.length > 0) await db.delete(commercialLeads).where(inArray(commercialLeads.id, createdLeadIds));
  await deleteTestOrganization(orgId);
  server.close();
  await queryClient.end();
});

test("no credential → 401", async () => {
  const res = await postLead(undefined, lead(), `k-${randomUUID()}`);
  assert.equal(res.status, 401);
});

test("an organization credential (another application, no lead.create) → 403", async () => {
  const res = await postLead(orgToken, lead(), `k-${randomUUID()}`);
  assert.equal(res.status, 403);
});

test("a UL_LANDING credential without lead.create → 403", async () => {
  const res = await postLead(landingNoScopeToken, lead(), `k-${randomUUID()}`);
  assert.equal(res.status, 403);
});

test("lead.create is allow-listed for UL_LANDING only", async () => {
  const actor = await createTestUser("leads-scope");
  await assert.rejects(
    () => createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id, scopes: ["lead.create"] }),
    ForbiddenError,
  );
});

test("missing or too-short Idempotency-Key → 400", async () => {
  assert.equal((await postLead(landingToken, lead())).status, 400);
  assert.equal((await postLead(landingToken, lead(), "short")).status, 400);
});

test("invalid payloads → 400 VALIDATION_ERROR without echoing values", async () => {
  const bad = await postLead(landingToken, lead({ email: "not-an-email" }), `k-${randomUUID()}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "VALIDATION_ERROR");
  assert.ok(!bad.raw.includes("not-an-email"));
  const unknown = await postLead(landingToken, { ...lead(), organizationId: randomUUID() }, `k-${randomUUID()}`);
  assert.equal(unknown.status, 400, "unknown fields are rejected, never silently accepted");
});

test("a valid lead → 201, persisted, acknowledged without personal data, audited without PII", async () => {
  const key = `k-${randomUUID()}`;
  const res = await postLead(landingToken, lead(), key);
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.data).sort(), ["createdAt", "id", "idempotent", "status"]);
  assert.equal(res.data.status, "NEW");
  assert.equal(res.data.idempotent, false);
  assert.ok(!res.raw.includes(MARK), "the response never echoes the submitted personal data");
  createdLeadIds.push(res.data.id);

  const [row] = await db.select().from(commercialLeads).where(eq(commercialLeads.id, res.data.id));
  assert.equal(row!.email, `${MARK}@example.test`, "email is normalized to lower case");
  assert.equal(row!.companyName, `Empresa ${MARK}`);
  assert.equal(row!.utmSource, "google");
  assert.equal(row!.idempotencyKey, key);

  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "commercial.lead.received"), eq(auditLogs.targetId, res.data.id)));
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits[0]).includes(MARK), "the audit trail carries no personal data");
});

test("same Idempotency-Key + same body → 200 with the original lead, never a duplicate", async () => {
  const key = `k-${randomUUID()}`;
  const first = await postLead(landingToken, lead({ companyName: `Replay ${MARK}` }), key);
  assert.equal(first.status, 201);
  createdLeadIds.push(first.data.id);
  const replay = await postLead(landingToken, lead({ companyName: `Replay ${MARK}` }), key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, first.data.id);
  assert.equal(replay.data.idempotent, true);
  const rows = await db.select().from(commercialLeads).where(eq(commercialLeads.idempotencyKey, key));
  assert.equal(rows.length, 1);
});

test("same Idempotency-Key + different body → 409", async () => {
  const key = `k-${randomUUID()}`;
  const first = await postLead(landingToken, lead({ companyName: `Conflict ${MARK}` }), key);
  assert.equal(first.status, 201);
  createdLeadIds.push(first.data.id);
  const conflict = await postLead(landingToken, lead({ companyName: `Other ${MARK}` }), key);
  assert.equal(conflict.status, 409);
});
