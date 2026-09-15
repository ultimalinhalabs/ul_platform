import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { memberships, roles } from "../src/db/schema/index.js";
import {
  createOrganization,
  deleteOrganization,
  getOrganizationById,
} from "../src/modules/organizations/service.js";
import { createTestUser, deleteTestUser } from "./helpers.js";
import { seed } from "../src/db/seed/index.js";
import { NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("creating an organization atomically grants the creator an active OWNER membership", async () => {
  await seed();
  const user = await createTestUser("org-create");

  const org = await createOrganization({ name: "Test Org", createdBy: user.id });

  try {
    assert.equal(org.createdBy, user.id);

    const [membership] = await db
      .select({ status: memberships.status, roleKey: roles.key })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.organizationId, org.id));

    assert.ok(membership);
    assert.equal(membership?.roleKey, "OWNER");
    assert.equal(membership?.status, "active");

    const fetched = await getOrganizationById(org.id);
    assert.equal(fetched.id, org.id);
  } finally {
    await deleteOrganization(org.id, user.id); // cascades the membership
    await deleteTestUser(user.id);
  }
});

test("getOrganizationById throws NotFoundError for a missing organization", async () => {
  await assert.rejects(
    () => getOrganizationById("00000000-0000-0000-0000-000000000000"),
    NotFoundError,
  );
});
