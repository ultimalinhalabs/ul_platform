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
import { ForbiddenError, NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("an ADMIN cannot grant the OWNER role to another member (privilege escalation)", async () => {
  await seed();
  const owner = await createTestUser("escalation-owner");
  const admin = await createTestUser("escalation-admin");
  const bystander = await createTestUser("escalation-bystander");
  const org = await createOrganization({ name: "Escalation Org", createdBy: owner.id });

  try {
    await createMembership({
      organizationId: org.id,
      userId: admin.id,
      roleKey: "ADMIN",
      actorUserId: owner.id,
      actorRoleKey: "OWNER",
    });

    await assert.rejects(
      () =>
        createMembership({
          organizationId: org.id,
          userId: bystander.id,
          roleKey: "OWNER",
          actorUserId: admin.id,
          actorRoleKey: "ADMIN",
        }),
      ForbiddenError,
    );
  } finally {
    await deleteOrganization(org.id, owner.id);
    await deleteTestUser(owner.id);
    await deleteTestUser(admin.id);
    await deleteTestUser(bystander.id);
  }
});

test("an ADMIN cannot change the role or status of an OWNER's membership", async () => {
  await seed();
  const owner = await createTestUser("neutralize-owner");
  const admin = await createTestUser("neutralize-admin");
  const org = await createOrganization({ name: "Neutralize Org", createdBy: owner.id });

  try {
    await createMembership({
      organizationId: org.id,
      userId: admin.id,
      roleKey: "ADMIN",
      actorUserId: owner.id,
      actorRoleKey: "OWNER",
    });

    const rows = await listMembershipsForOrganization(org.id);
    const ownerMembership = rows.find((r) => r.userId === owner.id)!;

    await assert.rejects(
      () =>
        updateMembership({
          organizationId: org.id,
          membershipId: ownerMembership.membershipId,
          status: "suspended",
          actorUserId: admin.id,
          actorRoleKey: "ADMIN",
        }),
      ForbiddenError,
    );

    await assert.rejects(
      () =>
        removeMembership({
          organizationId: org.id,
          membershipId: ownerMembership.membershipId,
          actorUserId: admin.id,
          actorRoleKey: "ADMIN",
        }),
      ForbiddenError,
    );
  } finally {
    await deleteOrganization(org.id, owner.id);
    await deleteTestUser(owner.id);
    await deleteTestUser(admin.id);
  }
});

test("a membership cannot be modified through a different organization's context (tenant isolation)", async () => {
  await seed();
  const ownerA = await createTestUser("tenant-a-owner");
  const ownerB = await createTestUser("tenant-b-owner");
  const orgA = await createOrganization({ name: "Tenant A", createdBy: ownerA.id });
  const orgB = await createOrganization({ name: "Tenant B", createdBy: ownerB.id });

  try {
    const [membershipB] = await listMembershipsForOrganization(orgB.id);
    assert.ok(membershipB);

    // ownerA is a genuine OWNER, but only within orgA — using orgA's id as
    // the scoping context to reach into orgB's membership must fail closed.
    await assert.rejects(
      () =>
        updateMembership({
          organizationId: orgA.id,
          membershipId: membershipB!.membershipId,
          status: "suspended",
          actorUserId: ownerA.id,
          actorRoleKey: "OWNER",
        }),
      NotFoundError,
    );
  } finally {
    await deleteOrganization(orgA.id, ownerA.id);
    await deleteOrganization(orgB.id, ownerB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});
