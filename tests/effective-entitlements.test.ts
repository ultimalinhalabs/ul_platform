import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, plans, subscriptions } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { getEffectiveEntitlement, getEffectiveEntitlements } from "../src/modules/entitlements/service.js";
import { cancelSubscription, createSubscription } from "../src/modules/subscriptions/service.js";
import { NotFoundError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

test("resolves the granting subscription's plan entitlements", async () => {
  await seed();
  const owner = await createTestUser("eff-basic");
  const org = await createTestOrganization("eff-basic");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });

    const resolved = await getEffectiveEntitlements(org.id, "NA_PISTA");
    assert.equal(resolved.application.key, "NA_PISTA");
    assert.equal(resolved.subscription?.id, subscription.id);
    assert.equal(resolved.subscription?.planKey, "BUSINESS");
    assert.deepEqual(
      resolved.entitlements.map((e) => e.key).sort(),
      ["advanced_reports.enabled", "catalog.enabled", "products.max"],
    );

    const single = await getEffectiveEntitlement(org.id, "NA_PISTA", "products.max");
    assert.equal(single.entitlement.value, 1000);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an organization with no subscription resolves to null/empty, not an error", async () => {
  await seed();
  const owner = await createTestUser("eff-none");
  const org = await createTestOrganization("eff-none");

  try {
    const resolved = await getEffectiveEntitlements(org.id, "NA_PISTA");
    assert.equal(resolved.subscription, null);
    assert.deepEqual(resolved.entitlements, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a subscription to a different application never leaks into this application's resolution", async () => {
  await seed();
  const owner = await createTestUser("eff-other-app");
  const org = await createTestOrganization("eff-other-app");

  try {
    await createSubscription({
      organizationId: org.id,
      applicationKey: "FOI",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });

    const resolved = await getEffectiveEntitlements(org.id, "NA_PISTA");
    assert.equal(resolved.subscription, null);
    assert.deepEqual(resolved.entitlements, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("getEffectiveEntitlements throws NotFoundError for an unknown application", async () => {
  const owner = await createTestUser("eff-unknown-app");
  const org = await createTestOrganization("eff-unknown-app");
  try {
    await assert.rejects(() => getEffectiveEntitlements(org.id, "UNKNOWN"), NotFoundError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("getEffectiveEntitlement 404s for an unknown key, even with a granting subscription", async () => {
  await seed();
  const owner = await createTestUser("eff-unknown-key");
  const org = await createTestOrganization("eff-unknown-key");

  try {
    await createSubscription({
      organizationId: org.id,
      applicationKey: "HOJE_TEM",
      planKey: "COMMUNITY",
      actorUserId: owner.id,
    });

    await assert.rejects(() => getEffectiveEntitlement(org.id, "HOJE_TEM", "not.a.key"), NotFoundError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a canceled subscription resolves to no effective entitlements", async () => {
  await seed();
  const owner = await createTestUser("eff-canceled");
  const org = await createTestOrganization("eff-canceled");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });
    await cancelSubscription({ organizationId: org.id, subscriptionId: subscription.id, actorUserId: owner.id });

    const resolved = await getEffectiveEntitlements(org.id, "QUALE_A_DICA");
    assert.equal(resolved.subscription, null);
    assert.deepEqual(resolved.entitlements, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("trialing and past_due subscriptions still grant effective entitlements", async () => {
  await seed();
  const owner = await createTestUser("eff-lifecycle-statuses");
  const org = await createTestOrganization("eff-lifecycle-statuses");

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "MICHA_EXPRESS",
      planKey: "BASIC",
      actorUserId: owner.id,
    });

    for (const status of ["trialing", "past_due"] as const) {
      await db.update(subscriptions).set({ status }).where(eq(subscriptions.id, subscription.id));
      const resolved = await getEffectiveEntitlements(org.id, "MICHA_EXPRESS");
      assert.equal(resolved.subscription?.status, status, `expected access while status=${status}`);
      assert.ok(resolved.entitlements.length > 0);
    }
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an ARCHIVED plan does not invalidate an existing subscription's resolved entitlements", async () => {
  await seed();
  const owner = await createTestUser("eff-archived-plan-history");
  const org = await createTestOrganization("eff-archived-plan-history");

  try {
    await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "STARTER",
      actorUserId: owner.id,
    });

    await db.update(plans).set({ status: "ARCHIVED" }).where(eq(plans.key, "STARTER"));

    const resolved = await getEffectiveEntitlements(org.id, "NA_PISTA");
    assert.ok(resolved.subscription, "a historical subscription must not be invalidated by plan archival");
    assert.equal(resolved.subscription?.planKey, "STARTER");
    assert.ok(resolved.entitlements.length > 0);
  } finally {
    await db.update(plans).set({ status: "ACTIVE" }).where(eq(plans.key, "STARTER"));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a SUSPENDED application does not invalidate an existing subscription's resolved entitlements", async () => {
  await seed();
  const owner = await createTestUser("eff-suspended-app-history");
  const org = await createTestOrganization("eff-suspended-app-history");

  try {
    await createSubscription({
      organizationId: org.id,
      applicationKey: "FOI",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });

    await db.update(applications).set({ status: "SUSPENDED" }).where(eq(applications.key, "FOI"));

    const resolved = await getEffectiveEntitlements(org.id, "FOI");
    assert.ok(resolved.subscription, "a historical subscription must not be invalidated by application suspension");
  } finally {
    await db.update(applications).set({ status: "ACTIVE" }).where(eq(applications.key, "FOI"));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a plan with zero entitlements resolves to an empty (not missing) entitlement list", async () => {
  await seed();
  const owner = await createTestUser("eff-empty-plan");
  const org = await createTestOrganization("eff-empty-plan");

  const [qualeADica] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.key, "QUALE_A_DICA"));
  const [emptyPlan] = await db
    .insert(plans)
    .values({ applicationId: qualeADica!.id, key: "EFF_TEST_EMPTY", name: "Empty Test Plan" })
    .returning();

  try {
    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      planKey: "EFF_TEST_EMPTY",
      actorUserId: owner.id,
    });

    const resolved = await getEffectiveEntitlements(org.id, "QUALE_A_DICA");
    assert.equal(resolved.subscription?.id, subscription.id);
    assert.deepEqual(resolved.entitlements, []);
  } finally {
    await deleteTestOrganization(org.id); // cascades the subscription
    await deleteTestUser(owner.id);
    await db.delete(plans).where(eq(plans.id, emptyPlan!.id));
  }
});
