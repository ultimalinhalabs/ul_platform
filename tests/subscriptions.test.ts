import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, plans } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import {
  cancelSubscription,
  createSubscription,
  getSubscriptionDetail,
  hasApplicationAccess,
  listSubscriptionsForOrganization,
} from "../src/modules/subscriptions/service.js";
import { ConflictError, NotFoundError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

test("creating a subscription succeeds for an ACTIVE plan of an ACTIVE application", async () => {
  await seed();
  const owner = await createTestUser("sub-create");
  const org = await createTestOrganization("sub-create");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "STARTER",
      actorUserId: owner.id,
    });
    assert.equal(subscription.status, "active");

    const detail = await getSubscriptionDetail(org.id, subscription.id);
    assert.equal(detail.application.key, "NA_PISTA");
    assert.equal(detail.plan.key, "STARTER");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("createSubscription rejects an unknown application/plan combination", async () => {
  await seed();
  const owner = await createTestUser("sub-unknown");
  const org = await createTestOrganization("sub-unknown");

  try {
    await assert.rejects(
      () =>
        createSubscription({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          planKey: "NOT_A_PLAN",
          actorUserId: owner.id,
        }),
      NotFoundError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("createSubscription rejects an ARCHIVED plan", async () => {
  await seed();
  const owner = await createTestUser("sub-archived-plan");
  const org = await createTestOrganization("sub-archived-plan");

  const [qualeADica] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.key, "QUALE_A_DICA"));
  const [archivedPlan] = await db
    .insert(plans)
    .values({
      applicationId: qualeADica!.id,
      key: "SUB_TEST_ARCHIVED",
      name: "Archived Test Plan",
      status: "ARCHIVED",
    })
    .returning();

  try {
    await assert.rejects(
      () =>
        createSubscription({
          organizationId: org.id,
          applicationKey: "QUALE_A_DICA",
          planKey: "SUB_TEST_ARCHIVED",
          actorUserId: owner.id,
        }),
      ConflictError,
    );
  } finally {
    await db.delete(plans).where(eq(plans.id, archivedPlan!.id));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("createSubscription rejects a SUSPENDED application", async () => {
  await seed();
  const owner = await createTestUser("sub-suspended-app");
  const org = await createTestOrganization("sub-suspended-app");

  await db.update(applications).set({ status: "SUSPENDED" }).where(eq(applications.key, "FOI"));

  try {
    await assert.rejects(
      () =>
        createSubscription({
          organizationId: org.id,
          applicationKey: "FOI",
          planKey: "BUSINESS",
          actorUserId: owner.id,
        }),
      ConflictError,
    );
  } finally {
    await db.update(applications).set({ status: "ACTIVE" }).where(eq(applications.key, "FOI"));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an organization cannot have two non-canceled subscriptions for the same application", async () => {
  await seed();
  const owner = await createTestUser("sub-duplicate");
  const org = await createTestOrganization("sub-duplicate");

  try {
    await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "STARTER",
      actorUserId: owner.id,
    });

    // same plan again
    await assert.rejects(
      () =>
        createSubscription({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          planKey: "STARTER",
          actorUserId: owner.id,
        }),
      ConflictError,
    );

    // different plan, same application — still ambiguous, still rejected
    await assert.rejects(
      () =>
        createSubscription({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          planKey: "BUSINESS",
          actorUserId: owner.id,
        }),
      ConflictError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("concurrent create requests for the same organization+application yield exactly one subscription", async () => {
  await seed();
  const owner = await createTestUser("sub-concurrent");
  const org = await createTestOrganization("sub-concurrent");

  try {
    const attempt = () =>
      createSubscription({
        organizationId: org.id,
        applicationKey: "MICHA_EXPRESS",
        planKey: "BASIC",
        actorUserId: owner.id,
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConflictError);

    const subs = await listSubscriptionsForOrganization(org.id);
    const nonCanceled = subs.filter((s) => s.status !== "canceled");
    assert.equal(nonCanceled.length, 1);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("listSubscriptionsForOrganization only returns that organization's subscriptions", async () => {
  await seed();
  const ownerA = await createTestUser("sub-list-a");
  const ownerB = await createTestUser("sub-list-b");
  const orgA = await createTestOrganization("sub-list-a");
  const orgB = await createTestOrganization("sub-list-b");

  try {
    await createSubscription({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      planKey: "STARTER",
      actorUserId: ownerA.id,
    });
    await createSubscription({
      organizationId: orgB.id,
      applicationKey: "FOI",
      planKey: "BUSINESS",
      actorUserId: ownerB.id,
    });

    const subsA = await listSubscriptionsForOrganization(orgA.id);
    const subsB = await listSubscriptionsForOrganization(orgB.id);
    assert.equal(subsA.length, 1);
    assert.equal(subsA[0]?.application.key, "NA_PISTA");
    assert.equal(subsB.length, 1);
    assert.equal(subsB[0]?.application.key, "FOI");
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("a subscription cannot be read or canceled through another organization's context", async () => {
  await seed();
  const ownerA = await createTestUser("sub-tenant-a");
  const ownerB = await createTestUser("sub-tenant-b");
  const orgA = await createTestOrganization("sub-tenant-a");
  const orgB = await createTestOrganization("sub-tenant-b");

  try {
    const subscriptionA = await createSubscription({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      planKey: "STARTER",
      actorUserId: ownerA.id,
    });

    await assert.rejects(() => getSubscriptionDetail(orgB.id, subscriptionA.id), NotFoundError);
    await assert.rejects(
      () => cancelSubscription({ organizationId: orgB.id, subscriptionId: subscriptionA.id, actorUserId: ownerB.id }),
      NotFoundError,
    );

    // sanity: it's still readable/cancelable through its own organization
    const detail = await getSubscriptionDetail(orgA.id, subscriptionA.id);
    assert.equal(detail.status, "active");
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("cancelSubscription moves ACTIVE to canceled and rejects canceling twice", async () => {
  await seed();
  const owner = await createTestUser("sub-cancel");
  const org = await createTestOrganization("sub-cancel");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });

    const canceled = await cancelSubscription({
      organizationId: org.id,
      subscriptionId: subscription.id,
      actorUserId: owner.id,
    });
    assert.equal(canceled.status, "canceled");
    assert.ok(canceled.canceledAt);

    await assert.rejects(
      () => cancelSubscription({ organizationId: org.id, subscriptionId: subscription.id, actorUserId: owner.id }),
      ConflictError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("hasApplicationAccess reflects subscription lifecycle", async () => {
  await seed();
  const owner = await createTestUser("sub-access");
  const org = await createTestOrganization("sub-access");

  try {
    assert.equal(await hasApplicationAccess(org.id, "HOJE_TEM"), false);

    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "HOJE_TEM",
      planKey: "COMMUNITY",
      actorUserId: owner.id,
    });
    assert.equal(await hasApplicationAccess(org.id, "HOJE_TEM"), true);

    await cancelSubscription({ organizationId: org.id, subscriptionId: subscription.id, actorUserId: owner.id });
    assert.equal(await hasApplicationAccess(org.id, "HOJE_TEM"), false);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});
