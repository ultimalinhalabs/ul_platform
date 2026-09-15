import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, plans } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { getPlanDetail, listPlansForApplication } from "../src/modules/plans/service.js";
import { NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("listPlansForApplication returns the seeded plans for that application only", async () => {
  await seed();
  const naPistaPlans = await listPlansForApplication("NA_PISTA");
  assert.deepEqual(naPistaPlans.map((p) => p.key).sort(), ["BUSINESS", "STARTER"]);
  assert.ok(naPistaPlans.every((p) => p.status === "ACTIVE"));

  const foiPlans = await listPlansForApplication("FOI");
  assert.deepEqual(foiPlans.map((p) => p.key), ["BUSINESS"]);
});

test("listPlansForApplication throws NotFoundError for an unknown application", async () => {
  await assert.rejects(() => listPlansForApplication("UNKNOWN"), NotFoundError);
});

test("getPlanDetail returns the plan's own entitlements, not another plan's", async () => {
  await seed();

  const naPistaBusiness = await getPlanDetail("NA_PISTA", "BUSINESS");
  const naPistaKeys = naPistaBusiness.plan.entitlements.map((e) => e.key).sort();
  assert.deepEqual(naPistaKeys, ["advanced_reports.enabled", "catalog.enabled", "products.max"]);
  assert.equal(naPistaBusiness.plan.entitlements.find((e) => e.key === "products.max")?.value, 1000);

  const michaExpressBusiness = await getPlanDetail("MICHA_EXPRESS", "BUSINESS");
  const michaKeys = michaExpressBusiness.plan.entitlements.map((e) => e.key).sort();
  assert.deepEqual(michaKeys, ["priority_support.enabled", "transactions.max"]);

  // same plan key ("BUSINESS"), different applications, disjoint entitlements
  assert.equal(naPistaKeys.some((k) => michaKeys.includes(k)), false);
});

test("a plan cannot be reached through the wrong application's context", async () => {
  await seed();
  // NA_PISTA has a STARTER plan; FOI does not.
  await assert.rejects(() => getPlanDetail("FOI", "STARTER"), NotFoundError);
});

test("getPlanDetail throws NotFoundError for an unknown plan key", async () => {
  await seed();
  await assert.rejects(() => getPlanDetail("NA_PISTA", "NOT_A_PLAN"), NotFoundError);
});

test("an ARCHIVED plan is hidden from the list but still reachable by detail", async () => {
  await seed();
  const [qualeADica] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.key, "QUALE_A_DICA"));
  assert.ok(qualeADica);

  const [archivedPlan] = await db
    .insert(plans)
    .values({
      applicationId: qualeADica!.id,
      key: "LEGACY_TEST_PLAN",
      name: "Legacy Test Plan",
      status: "ARCHIVED",
    })
    .returning();

  try {
    const listed = await listPlansForApplication("QUALE_A_DICA");
    assert.ok(!listed.some((p) => p.key === "LEGACY_TEST_PLAN"));

    const detail = await getPlanDetail("QUALE_A_DICA", "LEGACY_TEST_PLAN");
    assert.equal(detail.plan.status, "ARCHIVED");
  } finally {
    await db.delete(plans).where(eq(plans.id, archivedPlan!.id));
  }
});
