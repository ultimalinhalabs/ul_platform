import assert from "node:assert/strict";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { createOrganization, deleteOrganization } from "../src/modules/organizations/service.js";
import {
  createMembership,
  listMembershipsForOrganization,
  removeMembership,
  updateMembership,
} from "../src/modules/memberships/service.js";
import { seed } from "../src/db/seed/index.js";
import { createTestUser, deleteTestUser } from "./helpers.js";
import { ConflictError, NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("the organization's last active owner cannot be demoted or removed", async () => {
  await seed();
  const owner = await createTestUser("last-owner");
  const org = await createOrganization({ name: "Solo Org", createdBy: owner.id });

  try {
    const [ownerMembership] = await listMembershipsForOrganization(org.id);
    assert.ok(ownerMembership);

    await assert.rejects(
      () =>
        updateMembership({
          organizationId: org.id,
          membershipId: ownerMembership!.membershipId,
          status: "suspended",
          actorUserId: owner.id,
        }),
      ConflictError,
    );

    await assert.rejects(
      () =>
        removeMembership({
          organizationId: org.id,
          membershipId: ownerMembership!.membershipId,
          actorUserId: owner.id,
        }),
      ConflictError,
    );
  } finally {
    await deleteOrganization(org.id, owner.id);
    await deleteTestUser(owner.id);
  }
});

test("a second owner allows the first to be demoted, and a non-owner can be removed freely", async () => {
  await seed();
  const owner = await createTestUser("owner-a");
  const secondUser = await createTestUser("owner-b");
  const org = await createOrganization({ name: "Team Org", createdBy: owner.id });

  try {
    const secondMembership = await createMembership({
      organizationId: org.id,
      userId: secondUser.id,
      roleKey: "OWNER",
      actorUserId: owner.id,
    });

    const rows = await listMembershipsForOrganization(org.id);
    const firstOwnerMembership = rows.find((r) => r.userId === owner.id)!;

    // now that there are two active owners, demoting one is allowed
    const demoted = await updateMembership({
      organizationId: org.id,
      membershipId: firstOwnerMembership.membershipId,
      roleKey: "STAFF",
      actorUserId: owner.id,
    });
    assert.ok(demoted);

    // secondMembership (still OWNER) is now the sole active owner, so the
    // demoted first membership (now STAFF) can be removed freely.
    await removeMembership({
      organizationId: org.id,
      membershipId: firstOwnerMembership.membershipId,
      actorUserId: owner.id,
    });

    const remaining = await listMembershipsForOrganization(org.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.membershipId, secondMembership.id);
    assert.equal(remaining[0]?.roleKey, "OWNER");
  } finally {
    await deleteOrganization(org.id, owner.id);
    await deleteTestUser(owner.id);
    await deleteTestUser(secondUser.id);
  }
});

test("createMembership rejects an unknown user or an unknown role", async () => {
  await seed();
  const owner = await createTestUser("membership-validation");
  const org = await createOrganization({ name: "Validation Org", createdBy: owner.id });

  try {
    await assert.rejects(
      () =>
        createMembership({
          organizationId: org.id,
          userId: "00000000-0000-0000-0000-000000000000",
          roleKey: "STAFF",
          actorUserId: owner.id,
        }),
      NotFoundError,
    );

    await assert.rejects(
      () =>
        createMembership({
          organizationId: org.id,
          userId: owner.id,
          roleKey: "NOT_A_ROLE",
          actorUserId: owner.id,
        }),
      NotFoundError,
    );
  } finally {
    await deleteOrganization(org.id, owner.id);
    await deleteTestUser(owner.id);
  }
});
