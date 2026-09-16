import assert from "node:assert/strict";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { seed } from "../src/db/seed/index.js";
import {
  cancelSubscription,
  createSubscription,
  listOrganizationApplications,
} from "../src/modules/subscriptions/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

test("an organization with no subscriptions has no application access", async () => {
  await seed();
  const owner = await createTestUser("access-none");
  const org = await createTestOrganization("access-none");

  try {
    const access = await listOrganizationApplications(org.id);
    assert.deepEqual(access, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an active subscription grants visible application access; canceling revokes it", async () => {
  await seed();
  const owner = await createTestUser("access-lifecycle");
  const org = await createTestOrganization("access-lifecycle");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });

    const withAccess = await listOrganizationApplications(org.id);
    assert.equal(withAccess.length, 1);
    assert.equal(withAccess[0]?.application.key, "NA_PISTA");
    assert.equal(withAccess[0]?.plan.key, "BUSINESS");
    assert.equal(withAccess[0]?.subscription.status, "active");

    await cancelSubscription({ organizationId: org.id, subscriptionId: subscription.id, actorUserId: owner.id });

    const afterCancel = await listOrganizationApplications(org.id);
    assert.deepEqual(afterCancel, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("application access never leaks across organizations", async () => {
  await seed();
  const ownerA = await createTestUser("access-tenant-a");
  const ownerB = await createTestUser("access-tenant-b");
  const orgA = await createTestOrganization("access-tenant-a");
  const orgB = await createTestOrganization("access-tenant-b");

  try {
    await createSubscription({
      organizationId: orgA.id,
      applicationKey: "MICHA_EXPRESS",
      planKey: "BUSINESS",
      actorUserId: ownerA.id,
    });

    const accessA = await listOrganizationApplications(orgA.id);
    const accessB = await listOrganizationApplications(orgB.id);
    assert.equal(accessA.length, 1);
    assert.equal(accessB.length, 0);
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});
