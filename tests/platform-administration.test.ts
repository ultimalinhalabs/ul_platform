import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, auditLogs, platformMemberships, platformRoles } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { createApplication, updateApplication } from "../src/modules/applications/service.js";
import { findActiveMembership } from "../src/modules/memberships/service.js";
import { bootstrapFirstPlatformAdmin } from "../src/modules/platformAdmins/bootstrap.js";
import {
  findActivePlatformAdmin,
  grantPlatformAdmin,
  listPlatformAdmins,
  updatePlatformAdmin,
} from "../src/modules/platformAdmins/service.js";
import { platformRoleHasPermission } from "../src/modules/platformAuthorization/service.js";
import { ConflictError, NotFoundError } from "../src/shared/errors.js";
import { createTestUser, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

async function getPlatformRoleIdByKey(key: string) {
  const [role] = await db.select({ id: platformRoles.id }).from(platformRoles).where(eq(platformRoles.key, key));
  if (!role) throw new Error(`platform role "${key}" not seeded`);
  return role.id;
}

async function wipePlatformMembership(userId: string) {
  await db.delete(platformMemberships).where(eq(platformMemberships.userId, userId));
}

// ---------- Platform RBAC data model ----------

test("platform_roles/platform_permissions are a namespace separate from organization roles/permissions", async () => {
  await seed();
  const platformAdminRoleId = await getPlatformRoleIdByKey("PLATFORM_ADMIN");
  assert.equal(await platformRoleHasPermission(platformAdminRoleId, "platform.application.manage"), true);
  assert.equal(await platformRoleHasPermission(platformAdminRoleId, "platform.platform_admin.manage"), true);
  // organization-scoped permission keys must mean nothing in this namespace
  assert.equal(await platformRoleHasPermission(platformAdminRoleId, "organization.read"), false);
  assert.equal(await platformRoleHasPermission(platformAdminRoleId, "not.a.real.permission"), false);
});

test("findActivePlatformAdmin returns null for a user who was never granted platform authority", async () => {
  await seed();
  const user = await createTestUser("platform-none");
  try {
    assert.equal(await findActivePlatformAdmin(user.id), null);
  } finally {
    await deleteTestUser(user.id);
  }
});

// ---------- Bootstrap ----------

test("bootstrapFirstPlatformAdmin creates the first admin and is idempotent for the same user", async () => {
  await seed();
  const user = await createTestUser("bootstrap-first");
  try {
    const first = await bootstrapFirstPlatformAdmin(user.id);
    assert.equal(first.outcome, "created");

    const again = await bootstrapFirstPlatformAdmin(user.id);
    assert.equal(again.outcome, "already-bootstrapped");

    const admin = await findActivePlatformAdmin(user.id);
    assert.ok(admin);
    assert.equal(admin?.platformRoleKey, "PLATFORM_ADMIN");
  } finally {
    await wipePlatformMembership(user.id);
    await deleteTestUser(user.id);
  }
});

test("bootstrapFirstPlatformAdmin refuses to create a second admin once one already exists", async () => {
  await seed();
  const first = await createTestUser("bootstrap-existing");
  const second = await createTestUser("bootstrap-blocked");
  try {
    await bootstrapFirstPlatformAdmin(first.id);
    await assert.rejects(() => bootstrapFirstPlatformAdmin(second.id), /already has an active administrator/);
  } finally {
    await wipePlatformMembership(first.id);
    await deleteTestUser(first.id);
    await deleteTestUser(second.id);
  }
});

test("bootstrapFirstPlatformAdmin rejects a user id with no platform user row (never creates one)", async () => {
  await seed();
  await assert.rejects(
    () => bootstrapFirstPlatformAdmin("00000000-0000-0000-0000-000000000000"),
    /No platform user found/,
  );
});

// ---------- Grant / revoke ----------

test("grantPlatformAdmin grants a new admin and is audited as platform.admin.created", async () => {
  await seed();
  const bootstrapAdmin = await createTestUser("grant-bootstrap");
  const target = await createTestUser("grant-target");
  try {
    await bootstrapFirstPlatformAdmin(bootstrapAdmin.id);

    const granted = await grantPlatformAdmin({
      targetUserId: target.id,
      platformRoleKey: "PLATFORM_ADMIN",
      actorUserId: bootstrapAdmin.id,
    });
    assert.equal(granted.status, "ACTIVE");
    assert.equal(granted.platformRole, "PLATFORM_ADMIN");

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "platform.admin.created"));
    assert.ok(events.some((e) => e.targetType === "platform_membership"));
  } finally {
    await wipePlatformMembership(bootstrapAdmin.id);
    await wipePlatformMembership(target.id);
    await deleteTestUser(bootstrapAdmin.id);
    await deleteTestUser(target.id);
  }
});

test("grantPlatformAdmin rejects granting an already-active admin again", async () => {
  await seed();
  const user = await createTestUser("grant-duplicate");
  try {
    await bootstrapFirstPlatformAdmin(user.id);
    await assert.rejects(
      () => grantPlatformAdmin({ targetUserId: user.id, platformRoleKey: "PLATFORM_ADMIN" }),
      ConflictError,
    );
  } finally {
    await wipePlatformMembership(user.id);
    await deleteTestUser(user.id);
  }
});

test("grantPlatformAdmin rejects a target user that was never seen by the platform (never creates one)", async () => {
  await seed();
  await assert.rejects(
    () => grantPlatformAdmin({ targetUserId: "00000000-0000-0000-0000-000000000000", platformRoleKey: "PLATFORM_ADMIN" }),
    NotFoundError,
  );
});

test("updatePlatformAdmin can revoke an admin when another active admin exists, and is audited as platform.admin.revoked", async () => {
  await seed();
  const admin1 = await createTestUser("revoke-admin1");
  const admin2 = await createTestUser("revoke-admin2");
  try {
    await bootstrapFirstPlatformAdmin(admin1.id);
    await grantPlatformAdmin({ targetUserId: admin2.id, platformRoleKey: "PLATFORM_ADMIN", actorUserId: admin1.id });

    const revoked = await updatePlatformAdmin({ targetUserId: admin2.id, status: "REVOKED", actorUserId: admin1.id });
    assert.equal(revoked.status, "REVOKED");
    assert.equal(await findActivePlatformAdmin(admin2.id), null);

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "platform.admin.revoked"));
    assert.ok(events.length > 0);
  } finally {
    await wipePlatformMembership(admin1.id);
    await wipePlatformMembership(admin2.id);
    await deleteTestUser(admin1.id);
    await deleteTestUser(admin2.id);
  }
});

test("updatePlatformAdmin refuses to revoke an already-revoked admin (cannot be repeated)", async () => {
  await seed();
  const admin1 = await createTestUser("re-revoke-admin1");
  const admin2 = await createTestUser("re-revoke-admin2");
  try {
    await bootstrapFirstPlatformAdmin(admin1.id);
    await grantPlatformAdmin({ targetUserId: admin2.id, platformRoleKey: "PLATFORM_ADMIN", actorUserId: admin1.id });
    await updatePlatformAdmin({ targetUserId: admin2.id, status: "REVOKED", actorUserId: admin1.id });

    await assert.rejects(
      () => updatePlatformAdmin({ targetUserId: admin2.id, status: "REVOKED", actorUserId: admin1.id }),
      ConflictError,
    );
  } finally {
    await wipePlatformMembership(admin1.id);
    await wipePlatformMembership(admin2.id);
    await deleteTestUser(admin1.id);
    await deleteTestUser(admin2.id);
  }
});

test("updatePlatformAdmin refuses to revoke the platform's last active administrator", async () => {
  await seed();
  const solo = await createTestUser("last-admin");
  try {
    await bootstrapFirstPlatformAdmin(solo.id);
    await assert.rejects(
      () => updatePlatformAdmin({ targetUserId: solo.id, status: "REVOKED", actorUserId: solo.id }),
      ConflictError,
    );
    // still active afterwards — the rejected attempt must not have partially applied
    assert.ok(await findActivePlatformAdmin(solo.id));
  } finally {
    await wipePlatformMembership(solo.id);
    await deleteTestUser(solo.id);
  }
});

test("updatePlatformAdmin can reactivate a previously revoked admin via grantPlatformAdmin", async () => {
  await seed();
  const admin1 = await createTestUser("reactivate-admin1");
  const admin2 = await createTestUser("reactivate-admin2");
  try {
    await bootstrapFirstPlatformAdmin(admin1.id);
    await grantPlatformAdmin({ targetUserId: admin2.id, platformRoleKey: "PLATFORM_ADMIN", actorUserId: admin1.id });
    await updatePlatformAdmin({ targetUserId: admin2.id, status: "REVOKED", actorUserId: admin1.id });
    assert.equal(await findActivePlatformAdmin(admin2.id), null);

    const reactivated = await grantPlatformAdmin({
      targetUserId: admin2.id,
      platformRoleKey: "PLATFORM_ADMIN",
      actorUserId: admin1.id,
    });
    assert.equal(reactivated.status, "ACTIVE");
    assert.ok(await findActivePlatformAdmin(admin2.id));
  } finally {
    await wipePlatformMembership(admin1.id);
    await wipePlatformMembership(admin2.id);
    await deleteTestUser(admin1.id);
    await deleteTestUser(admin2.id);
  }
});

test("updatePlatformAdmin 404s for a user who was never granted platform authority", async () => {
  await seed();
  const user = await createTestUser("update-never-granted");
  try {
    await assert.rejects(() => updatePlatformAdmin({ targetUserId: user.id, status: "REVOKED" }), NotFoundError);
  } finally {
    await deleteTestUser(user.id);
  }
});

test("listPlatformAdmins includes both active and revoked rows (auditable history, never deleted)", async () => {
  await seed();
  const admin1 = await createTestUser("list-admin1");
  const admin2 = await createTestUser("list-admin2");
  try {
    await bootstrapFirstPlatformAdmin(admin1.id);
    await grantPlatformAdmin({ targetUserId: admin2.id, platformRoleKey: "PLATFORM_ADMIN", actorUserId: admin1.id });
    await updatePlatformAdmin({ targetUserId: admin2.id, status: "REVOKED", actorUserId: admin1.id });

    const list = await listPlatformAdmins();
    const row1 = list.find((r) => r.userId === admin1.id);
    const row2 = list.find((r) => r.userId === admin2.id);
    assert.equal(row1?.status, "ACTIVE");
    assert.equal(row2?.status, "REVOKED");
  } finally {
    await wipePlatformMembership(admin1.id);
    await wipePlatformMembership(admin2.id);
    await deleteTestUser(admin1.id);
    await deleteTestUser(admin2.id);
  }
});

// ---------- Tenant isolation: PLATFORM_ADMIN != unrestricted tenant access ----------

test("a platform admin gains no implicit access to any Organization's data", async () => {
  await seed();
  const admin = await createTestUser("isolation-admin");
  try {
    await bootstrapFirstPlatformAdmin(admin.id);
    assert.ok(await findActivePlatformAdmin(admin.id));

    // The exact same organization-membership resolver every org route uses —
    // holding platform authority must not make this resolve to anything.
    const someOrgId = "00000000-0000-0000-0000-000000000001";
    assert.equal(await findActiveMembership(admin.id, someOrgId), null);
  } finally {
    await wipePlatformMembership(admin.id);
    await deleteTestUser(admin.id);
  }
});

// ---------- Applications: create/update (platform-administered global registry) ----------

test("createApplication registers a new application ACTIVE by default, and is audited", async () => {
  await seed();
  const key = `TEST_APP_${Date.now()}`;
  try {
    const created = await createApplication({ key, name: "Test App" });
    assert.equal(created.key, key);
    assert.equal(created.status, "ACTIVE");

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "platform.application.created"));
    assert.ok(events.some((e) => e.targetId === key));
  } finally {
    await db.delete(applications).where(eq(applications.key, key));
  }
});

test("createApplication rejects a duplicate key", async () => {
  await seed();
  await assert.rejects(() => createApplication({ key: "NA_PISTA", name: "Duplicate" }), ConflictError);
});

test("updateApplication can transition status through the existing lifecycle, and is audited", async () => {
  await seed();
  const key = `TEST_APP_${Date.now()}`;
  try {
    await createApplication({ key, name: "Test App" });
    const suspended = await updateApplication(key, { status: "SUSPENDED" });
    assert.equal(suspended.status, "SUSPENDED");

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "platform.application.updated"));
    assert.ok(events.some((e) => e.targetId === key));
  } finally {
    await db.delete(applications).where(eq(applications.key, key));
  }
});

test("updateApplication 404s for an unknown application key", async () => {
  await seed();
  await assert.rejects(() => updateApplication("NOT_A_REAL_APP", { status: "SUSPENDED" }), NotFoundError);
});
