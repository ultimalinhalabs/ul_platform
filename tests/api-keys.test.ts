import assert from "node:assert/strict";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { apiKeys, applications, auditLogs } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import {
  createOrganizationApiKey,
  getApiKeyDetail,
  listApiKeysForOrganization,
  revokeApiKey,
  verifyApiKeyToken,
} from "../src/modules/apiKeys/service.js";
import { parseApiKeyToken } from "../src/modules/apiKeys/crypto.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

test("creating an API key returns the secret once and never persists it in plaintext", async () => {
  await seed();
  const owner = await createTestUser("apikey-create");
  const org = await createTestOrganization("apikey-create");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
    });

    assert.equal(created.application, "NA_PISTA");
    assert.equal(created.organizationId, org.id);
    assert.equal(created.status, "ACTIVE");
    assert.ok(created.secret.startsWith("ulk_"));

    const parsed = parseApiKeyToken(created.secret);
    assert.ok(parsed);
    assert.equal(parsed?.id, created.id);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    assert.ok(row);
    assert.notEqual(row?.secretHash, parsed?.secret);
    assert.equal((row as unknown as { secret?: unknown }).secret, undefined);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a valid API key authenticates and resolves its own application/organization", async () => {
  await seed();
  const owner = await createTestUser("apikey-verify");
  const org = await createTestOrganization("apikey-verify");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "FOI",
      actorUserId: owner.id,
    });

    const verified = await verifyApiKeyToken(created.secret);
    assert.equal(verified.applicationKey, "FOI");
    assert.equal(verified.organizationId, org.id);
    assert.equal(verified.apiKeyId, created.id);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("verifyApiKeyToken rejects a wrong secret, an unknown id, and malformed tokens", async () => {
  await seed();
  const owner = await createTestUser("apikey-invalid");
  const org = await createTestOrganization("apikey-invalid");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
    });
    const parsed = parseApiKeyToken(created.secret)!;

    await assert.rejects(
      () => verifyApiKeyToken(`ulk_${parsed.id}.wrong-secret-value`),
      UnauthorizedError,
    );
    await assert.rejects(
      () => verifyApiKeyToken("ulk_00000000-0000-0000-0000-000000000000.somesecret"),
      UnauthorizedError,
    );
    await assert.rejects(() => verifyApiKeyToken("ulk_not-a-uuid.somesecret"), UnauthorizedError);
    await assert.rejects(() => verifyApiKeyToken("not-even-prefixed"), UnauthorizedError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a revoked key immediately stops authenticating", async () => {
  await seed();
  const owner = await createTestUser("apikey-revoke-auth");
  const org = await createTestOrganization("apikey-revoke-auth");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
    });
    await verifyApiKeyToken(created.secret); // sanity: works before revocation

    await revokeApiKey({ organizationId: org.id, keyId: created.id, actorUserId: owner.id });

    await assert.rejects(() => verifyApiKeyToken(created.secret), UnauthorizedError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an expired key does not authenticate", async () => {
  await seed();
  const owner = await createTestUser("apikey-expired");
  const org = await createTestOrganization("apikey-expired");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await assert.rejects(() => verifyApiKeyToken(created.secret), UnauthorizedError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a key belonging to a SUSPENDED application does not authenticate, without mutating the key itself", async () => {
  await seed();
  const owner = await createTestUser("apikey-suspended-app");
  const org = await createTestOrganization("apikey-suspended-app");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      actorUserId: owner.id,
    });

    await db.update(applications).set({ status: "SUSPENDED" }).where(eq(applications.key, "QUALE_A_DICA"));

    await assert.rejects(() => verifyApiKeyToken(created.secret), UnauthorizedError);

    const [row] = await db.select({ status: apiKeys.status }).from(apiKeys).where(eq(apiKeys.id, created.id));
    assert.equal(row?.status, "ACTIVE", "suspending the application must not mutate the key row");
  } finally {
    await db.update(applications).set({ status: "ACTIVE" }).where(eq(applications.key, "QUALE_A_DICA"));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("listApiKeysForOrganization and getApiKeyDetail are tenant-scoped", async () => {
  await seed();
  const ownerA = await createTestUser("apikey-tenant-a");
  const ownerB = await createTestUser("apikey-tenant-b");
  const orgA = await createTestOrganization("apikey-tenant-a");
  const orgB = await createTestOrganization("apikey-tenant-b");

  try {
    const keyA = await createOrganizationApiKey({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      actorUserId: ownerA.id,
    });
    await createOrganizationApiKey({
      organizationId: orgB.id,
      applicationKey: "FOI",
      actorUserId: ownerB.id,
    });

    const listA = await listApiKeysForOrganization(orgA.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.id, keyA.id);

    await assert.rejects(() => getApiKeyDetail(orgB.id, keyA.id), NotFoundError);

    const detail = await getApiKeyDetail(orgA.id, keyA.id);
    assert.equal(detail.id, keyA.id);
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("revoking a key cannot be done through another organization's context, and cannot be repeated", async () => {
  await seed();
  const ownerA = await createTestUser("apikey-revoke-tenant-a");
  const ownerB = await createTestUser("apikey-revoke-tenant-b");
  const orgA = await createTestOrganization("apikey-revoke-tenant-a");
  const orgB = await createTestOrganization("apikey-revoke-tenant-b");

  try {
    const keyA = await createOrganizationApiKey({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      actorUserId: ownerA.id,
    });

    await assert.rejects(
      () => revokeApiKey({ organizationId: orgB.id, keyId: keyA.id, actorUserId: ownerB.id }),
      NotFoundError,
    );

    const revoked = await revokeApiKey({ organizationId: orgA.id, keyId: keyA.id, actorUserId: ownerA.id });
    assert.equal(revoked.status, "REVOKED");

    await assert.rejects(
      () => revokeApiKey({ organizationId: orgA.id, keyId: keyA.id, actorUserId: ownerA.id }),
      ConflictError,
    );
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("creation and revocation are audited, and no secret material ever appears in the audit log", async () => {
  await seed();
  const owner = await createTestUser("apikey-audit");
  const org = await createTestOrganization("apikey-audit");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
    });
    await revokeApiKey({ organizationId: org.id, keyId: created.id, actorUserId: owner.id });

    const events = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "api_key"), eq(auditLogs.targetId, created.id)));

    const actions = events.map((e) => e.action).sort();
    assert.deepEqual(actions, ["api_key.created", "api_key.revoked"]);

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(created.secret), "raw secret must never reach the audit log");
    const secretPart = created.secret.split(".")[1]!;
    assert.ok(!serialized.includes(secretPart), "raw secret component must never reach the audit log");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});
