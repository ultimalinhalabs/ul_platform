import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { memberships, roles } from "../src/db/schema/index.js";

after(() => queryClient.end());
import { roleHasPermission } from "../src/modules/authorization/service.js";
import { findActiveMembership } from "../src/modules/memberships/service.js";
import { seed } from "../src/db/seed/index.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

async function getRoleIdByKey(key: string) {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!role) throw new Error(`role "${key}" not seeded`);
  return role.id;
}

test("user with no membership cannot access the organization", async () => {
  await seed();
  const user = await createTestUser("authz-no-membership");
  const org = await createTestOrganization("authz-no-membership");

  try {
    const membership = await findActiveMembership(user.id, org.id);
    assert.equal(membership, null);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(user.id);
  }
});

test("active membership grants access and the role's seeded permissions", async () => {
  await seed();
  const user = await createTestUser("authz-owner");
  const org = await createTestOrganization("authz-owner");
  const ownerRoleId = await getRoleIdByKey("OWNER");

  await db.insert(memberships).values({
    userId: user.id,
    organizationId: org.id,
    roleId: ownerRoleId,
    status: "active",
  });

  try {
    const membership = await findActiveMembership(user.id, org.id);
    assert.ok(membership);
    assert.equal(membership?.roleKey, "OWNER");

    assert.equal(await roleHasPermission(ownerRoleId, "organization.read"), true);
    assert.equal(await roleHasPermission(ownerRoleId, "membership.remove"), true);
    assert.equal(await roleHasPermission(ownerRoleId, "not.a.real.permission"), false);
  } finally {
    await deleteTestOrganization(org.id); // cascades the membership
    await deleteTestUser(user.id);
  }
});

test("STAFF role is read-only: lacks membership.create", async () => {
  await seed();
  const staffRoleId = await getRoleIdByKey("STAFF");

  assert.equal(await roleHasPermission(staffRoleId, "organization.read"), true);
  assert.equal(await roleHasPermission(staffRoleId, "membership.create"), false);
});
