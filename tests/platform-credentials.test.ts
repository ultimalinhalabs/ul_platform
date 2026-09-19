import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { apiKeys, auditLogs } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import {
  createPlatformApiKey,
  listPlatformApiKeys,
  revokePlatformApiKey,
  verifyApiKeyToken,
} from "../src/modules/apiKeys/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";
import { ConflictError, NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

async function wipeApiKey(id: string) {
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}

test("createPlatformApiKey always persists organizationId = null, regardless of caller", async () => {
  await seed();
  const actor = await createTestUser("cred-null-actor");
  try {
    const created = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
    assert.equal(created.organizationId, null);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    assert.equal(row?.organizationId, null);

    await wipeApiKey(created.id);
  } finally {
    await deleteTestUser(actor.id);
  }
});

test("the secret is returned exactly once, at creation, and is never persisted in plaintext", async () => {
  await seed();
  const actor = await createTestUser("cred-secret-once-actor");
  const created = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
  try {
    assert.ok(created.secret.startsWith("ulk_"));

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    assert.ok(row);
    assert.notEqual(row!.secretHash, created.secret);
    assert.doesNotMatch(row!.secretHash, /^ulk_/, "only a hash is stored, never the raw token");

    // listPlatformApiKeys / shapeMetadata must never re-expose it
    const list = await listPlatformApiKeys();
    const listed = list.find((k) => k.id === created.id);
    assert.ok(listed);
    assert.ok(!("secret" in listed!));
    assert.ok(!("secretHash" in listed!));
  } finally {
    await wipeApiKey(created.id);
    await deleteTestUser(actor.id);
  }
});

test("a freshly created platform key verifies via verifyApiKeyToken with organizationId null", async () => {
  await seed();
  const actor = await createTestUser("cred-verify-actor");
  const created = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
  try {
    const verified = await verifyApiKeyToken(created.secret);
    assert.equal(verified.applicationKey, "NA_PISTA");
    assert.equal(verified.organizationId, null);
  } finally {
    await wipeApiKey(created.id);
    await deleteTestUser(actor.id);
  }
});

test("createPlatformApiKey 404s for an unknown application", async () => {
  await seed();
  const actor = await createTestUser("cred-unknown-app-actor");
  try {
    await assert.rejects(
      () => createPlatformApiKey({ applicationKey: "NOT_A_REAL_APP", actorUserId: actor.id }),
      NotFoundError,
    );
  } finally {
    await deleteTestUser(actor.id);
  }
});

test("listPlatformApiKeys only ever returns organizationId = null rows, never an Organization's own key", async () => {
  await seed();
  const actor = await createTestUser("cred-list-isolation-actor");
  const org = await createTestOrganization("cred-list-isolation-org", actor.id);
  const platformKey = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
  try {
    const { createOrganizationApiKey } = await import("../src/modules/apiKeys/service.js");
    const orgKey = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: actor.id,
    });
    try {
      const list = await listPlatformApiKeys();
      assert.ok(list.some((k) => k.id === platformKey.id));
      assert.ok(!list.some((k) => k.id === orgKey.id), "an org-scoped key must never appear in the platform list");
    } finally {
      await wipeApiKey(orgKey.id);
    }
  } finally {
    await wipeApiKey(platformKey.id);
    await deleteTestOrganization(org.id);
    await deleteTestUser(actor.id);
  }
});

test("revokePlatformApiKey revokes and is audited as platform.credential.revoked, without a secret in metadata", async () => {
  await seed();
  const actor = await createTestUser("cred-revoke-actor");
  const created = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
  try {
    const revoked = await revokePlatformApiKey({ keyId: created.id, actorUserId: actor.id });
    assert.equal(revoked.status, "REVOKED");

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "platform.credential.revoked"));
    const event = events.find((e) => e.targetId === created.id);
    assert.ok(event);
    assert.equal(JSON.stringify(event?.metadata ?? {}).includes(created.secret), false);
  } finally {
    await wipeApiKey(created.id);
    await deleteTestUser(actor.id);
  }
});

test("revokePlatformApiKey refuses to revoke an already-revoked key", async () => {
  await seed();
  const actor = await createTestUser("cred-re-revoke-actor");
  const created = await createPlatformApiKey({ applicationKey: "NA_PISTA", actorUserId: actor.id });
  try {
    await revokePlatformApiKey({ keyId: created.id, actorUserId: actor.id });
    await assert.rejects(() => revokePlatformApiKey({ keyId: created.id, actorUserId: actor.id }), ConflictError);
  } finally {
    await wipeApiKey(created.id);
    await deleteTestUser(actor.id);
  }
});

test("revokePlatformApiKey can never revoke an Organization's own (non-null organizationId) key", async () => {
  await seed();
  const actor = await createTestUser("cred-cross-scope-actor");
  const org = await createTestOrganization("cred-cross-scope-org", actor.id);
  try {
    const { createOrganizationApiKey } = await import("../src/modules/apiKeys/service.js");
    const orgKey = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: actor.id,
    });
    try {
      await assert.rejects(() => revokePlatformApiKey({ keyId: orgKey.id, actorUserId: actor.id }), NotFoundError);
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, orgKey.id));
      assert.equal(row?.status, "ACTIVE", "the org key must remain untouched");
    } finally {
      await wipeApiKey(orgKey.id);
    }
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(actor.id);
  }
});
