import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { auditLogs, platformMemberships } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { recordAuditEvent, listPlatformAuditLogs } from "../src/modules/audit/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";
import { ValidationError } from "../src/shared/errors.js";

after(() => queryClient.end());

async function wipeAuditAction(action: string) {
  await db.delete(auditLogs).where(eq(auditLogs.action, action));
}

test("listPlatformAuditLogs never returns a row whose action is outside the control-plane prefix allowlist", async () => {
  await seed();
  const actor = await createTestUser("audit-boundary-actor");
  const org = await createTestOrganization("audit-boundary-org", actor.id);
  // Real control-plane and tenant prefixes — not arbitrary strings. The
  // service filters by `action LIKE 'platform.%' OR 'environment.%' OR
  // 'endpoint.%' OR 'integration.%'`, so a probe must use one of those
  // real prefixes to prove inclusion, and a namespace outside it (here
  // `membership.*`, a real tenant prefix) to prove exclusion.
  const platformAction = `platform.test.action.${Date.now()}`;
  const tenantAction = `membership.test.action.${Date.now()}`;
  try {
    await recordAuditEvent({ actorUserId: actor.id, action: platformAction, targetType: "thing", targetId: "1" });
    await recordAuditEvent({
      actorUserId: actor.id,
      organizationId: org.id,
      action: tenantAction,
      targetType: "thing",
      targetId: "2",
    });

    const platformResult = await listPlatformAuditLogs({ action: platformAction, limit: 10 });
    assert.equal(platformResult.items.length, 1);
    assert.equal(platformResult.items[0]?.action, platformAction);

    // The tenant-scoped row must be invisible to this endpoint no matter what filter is used.
    const tenantResult = await listPlatformAuditLogs({ action: tenantAction, limit: 10 });
    assert.equal(tenantResult.items.length, 0);
  } finally {
    await wipeAuditAction(platformAction);
    await wipeAuditAction(tenantAction);
    await deleteTestOrganization(org.id);
    await deleteTestUser(actor.id);
  }
});

test("a tenant event stays excluded even after its Organization is deleted and organizationId is cascaded to null", async () => {
  // Regression test for a real bug found via scripts/smoke.ts: audit_logs.organizationId
  // is ON DELETE SET NULL (see db/schema/audit.ts), so filtering this endpoint by
  // `organizationId IS NULL` alone let every tenant event whose Organization was later
  // deleted leak into the control-plane audit log — 228 historical `api_key.created`
  // rows in the dev DB all read organizationId: null for exactly this reason. The fix
  // is the action-prefix allowlist; this proves it holds even once the FK has fired.
  await seed();
  const actor = await createTestUser("audit-cascade-actor");
  const org = await createTestOrganization("audit-cascade-org", actor.id);
  const tenantAction = `api_key.test.action.${Date.now()}`;
  try {
    await recordAuditEvent({
      actorUserId: actor.id,
      organizationId: org.id,
      action: tenantAction,
      targetType: "api_key",
      targetId: "cascade-1",
    });

    await deleteTestOrganization(org.id); // triggers ON DELETE SET NULL on audit_logs.organization_id

    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.action, tenantAction));
    assert.equal(row?.organizationId, null, "sanity check: the cascade actually fired");

    const result = await listPlatformAuditLogs({ action: tenantAction, limit: 10 });
    assert.equal(result.items.length, 0, "a cascaded-to-null tenant event must still never appear here");
  } finally {
    await wipeAuditAction(tenantAction);
    await deleteTestUser(actor.id);
  }
});

test("listPlatformAuditLogs filters by actorUserId, targetType, and targetId", async () => {
  await seed();
  const actor = await createTestUser("audit-filter-actor");
  const otherActor = await createTestUser("audit-filter-other");
  const action = `platform.test.filter.action.${Date.now()}`;
  try {
    await recordAuditEvent({ actorUserId: actor.id, action, targetType: "widget", targetId: "abc" });
    await recordAuditEvent({ actorUserId: otherActor.id, action, targetType: "widget", targetId: "xyz" });

    const byActor = await listPlatformAuditLogs({ action, actorUserId: actor.id, limit: 10 });
    assert.equal(byActor.items.length, 1);
    assert.equal(byActor.items[0]?.targetId, "abc");

    const byTargetId = await listPlatformAuditLogs({ action, targetId: "xyz", limit: 10 });
    assert.equal(byTargetId.items.length, 1);
    assert.equal(byTargetId.items[0]?.actorUserId, otherActor.id);
  } finally {
    await wipeAuditAction(action);
    await deleteTestUser(actor.id);
    await deleteTestUser(otherActor.id);
  }
});

test("listPlatformAuditLogs paginates with a stable cursor, newest first, no duplicates or gaps", async () => {
  await seed();
  const actor = await createTestUser("audit-paginate-actor");
  const action = `platform.test.paginate.action.${Date.now()}`;
  try {
    for (let i = 0; i < 5; i++) {
      await recordAuditEvent({ actorUserId: actor.id, action, targetType: "page", targetId: String(i) });
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await listPlatformAuditLogs({ action, limit: 2, cursor: cursor ?? undefined });
      seen.push(...page.items.map((i) => i.targetId!));
      cursor = page.nextCursor;
    } while (cursor);

    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, "no row should appear twice across pages");
    // newest first — the last-inserted row (targetId "4") comes first
    assert.equal(seen[0], "4");
    assert.equal(seen[4], "0");
  } finally {
    await wipeAuditAction(action);
    await deleteTestUser(actor.id);
  }
});

test("listPlatformAuditLogs rejects a malformed cursor rather than silently ignoring it", async () => {
  await seed();
  await assert.rejects(() => listPlatformAuditLogs({ cursor: "not-a-real-cursor", limit: 10 }), ValidationError);
});

test("listPlatformAuditLogs filters by a createdAt date range", async () => {
  await seed();
  const actor = await createTestUser("audit-range-actor");
  const action = `platform.test.range.action.${Date.now()}`;
  try {
    await recordAuditEvent({ actorUserId: actor.id, action, targetType: "range", targetId: "1" });

    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);

    const withinRange = await listPlatformAuditLogs({ action, from: past, to: future, limit: 10 });
    assert.equal(withinRange.items.length, 1);

    const outsideRange = await listPlatformAuditLogs({ action, from: future, limit: 10 });
    assert.equal(outsideRange.items.length, 0);
  } finally {
    await wipeAuditAction(action);
    await deleteTestUser(actor.id);
  }
});

test("a real platform.admin.created event is visible through the control-plane audit read path", async () => {
  await seed();
  const { bootstrapFirstPlatformAdmin } = await import("../src/modules/platformAdmins/bootstrap.js");
  const admin = await createTestUser("audit-realevent-admin");
  try {
    await bootstrapFirstPlatformAdmin(admin.id);
    const result = await listPlatformAuditLogs({ action: "platform.admin.created", targetType: "platform_membership", limit: 50 });
    assert.ok(result.items.some((i) => i.metadata && (i.metadata as Record<string, unknown>).targetUserId === admin.id));
  } finally {
    await db.delete(platformMemberships).where(eq(platformMemberships.userId, admin.id));
    await deleteTestUser(admin.id);
  }
});
