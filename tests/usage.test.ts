import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, usageEvents } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { requireServiceApplicationMatch } from "../src/middleware/requireServiceApplicationMatch.js";
import { requireUsageReadAccess } from "../src/middleware/usageAccess.js";
import { createSubscription, cancelSubscription } from "../src/modules/subscriptions/service.js";
import { recordUsageSchema } from "../src/modules/usage/schemas.js";
import {
  getUsageForApplication,
  getUsageForMeter,
  listApplicationMeters,
  listMeters,
  recordUsage,
} from "../src/modules/usage/service.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

function fakeReq(overrides: Partial<Request>): Request {
  return { params: {}, ...overrides } as unknown as Request;
}

function captureNext(): { next: (error?: unknown) => void; error: unknown } {
  const state = { next: (() => {}) as (error?: unknown) => void, error: undefined as unknown };
  state.next = (error?: unknown) => {
    state.error = error;
  };
  return state;
}

// ---------- Meter registry ----------

test("the meter registry is seeded with the platform's generic measurable resources", async () => {
  await seed();
  const meterList = await listMeters();
  const keys = meterList.map((m) => m.key);
  assert.ok(keys.includes("orders"));
  assert.ok(keys.includes("api_requests"));
});

test("an application's allowed meters are a strict subset of the registry", async () => {
  await seed();
  const naPista = await listApplicationMeters("NA_PISTA");
  const naPistaKeys = naPista.meters.map((m) => m.key);
  assert.ok(naPistaKeys.includes("orders"));
  assert.ok(!naPistaKeys.includes("transactions"), "NA_PISTA must not be allowed a MICHA_EXPRESS-only meter");
});

// ---------- Recording ----------

test("recordUsage persists a valid event for an allowed meter", async () => {
  await seed();
  const owner = await createTestUser("usage-record-valid");
  const org = await createTestOrganization("usage-record-valid");

  try {
    const result = await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "3",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });
    assert.equal(result.idempotent, false);
    assert.equal(result.meter.key, "orders");
    assert.equal(result.meter.unit, "count");
    assert.equal(result.quantity, 3);
    assert.equal(result.application, "NA_PISTA");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("recordUsage rejects an unknown meter", async () => {
  await seed();
  const owner = await createTestUser("usage-record-unknown-meter");
  const org = await createTestOrganization("usage-record-unknown-meter");

  try {
    await assert.rejects(
      () =>
        recordUsage({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          meterKey: "not_a_real_meter",
          quantity: "1",
          idempotencyKey: `usage_evt_${randomUUID()}`,
        }),
      NotFoundError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("recordUsage rejects a meter this application is not authorized for (application isolation at the registry level)", async () => {
  await seed();
  const owner = await createTestUser("usage-record-cross-app-meter");
  const org = await createTestOrganization("usage-record-cross-app-meter");

  try {
    await assert.rejects(
      () =>
        recordUsage({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          meterKey: "transactions", // real meter, MICHA_EXPRESS-only
          quantity: "1",
          idempotencyKey: `usage_evt_${randomUUID()}`,
        }),
      ForbiddenError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("recordUsage rejects an unknown organization instead of leaking a raw foreign-key error", async () => {
  await seed();
  await assert.rejects(
    () =>
      recordUsage({
        organizationId: randomUUID(),
        applicationKey: "NA_PISTA",
        meterKey: "orders",
        quantity: "1",
        idempotencyKey: `usage_evt_${randomUUID()}`,
      }),
    NotFoundError,
  );
});

test("recordUsage rejects an unknown application", async () => {
  await seed();
  const owner = await createTestUser("usage-record-unknown-app");
  const org = await createTestOrganization("usage-record-unknown-app");

  try {
    await assert.rejects(
      () =>
        recordUsage({
          organizationId: org.id,
          applicationKey: "NOT_A_REAL_APP",
          meterKey: "orders",
          quantity: "1",
          idempotencyKey: `usage_evt_${randomUUID()}`,
        }),
      NotFoundError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("recordUsageSchema rejects zero, negative and non-numeric quantities", () => {
  const base = { meterKey: "orders", idempotencyKey: "usage_evt_1" };
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: 0 }).success, false);
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: -5 }).success, false);
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: "not-a-number" }).success, false);
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: "abc123" }).success, false);
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: 5 }).success, true);
  assert.equal(recordUsageSchema.safeParse({ ...base, quantity: "12.5" }).success, true);
});

test("recordUsage is idempotent: submitting the same event twice does not double-count", async () => {
  await seed();
  const owner = await createTestUser("usage-idempotent");
  const org = await createTestOrganization("usage-idempotent");
  const idempotencyKey = `usage_evt_${randomUUID()}`;

  try {
    const first = await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "1",
      idempotencyKey,
    });
    const second = await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "1",
      idempotencyKey,
    });

    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.id, first.id);

    const total = await getUsageForMeter({ organizationId: org.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    assert.equal(total.quantity, 1, "the duplicate submission must not have counted as a second event");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("concurrent duplicate submissions resolve to exactly one persisted row", async () => {
  await seed();
  const owner = await createTestUser("usage-concurrent-idempotent");
  const org = await createTestOrganization("usage-concurrent-idempotent");
  const idempotencyKey = `usage_evt_${randomUUID()}`;

  try {
    const [a, b] = await Promise.all([
      recordUsage({
        organizationId: org.id,
        applicationKey: "NA_PISTA",
        meterKey: "orders",
        quantity: "1",
        idempotencyKey,
      }),
      recordUsage({
        organizationId: org.id,
        applicationKey: "NA_PISTA",
        meterKey: "orders",
        quantity: "1",
        idempotencyKey,
      }),
    ]);

    assert.equal(a.id, b.id);
    assert.ok(a.idempotent || b.idempotent, "exactly one of the two concurrent calls must observe the conflict");

    const rows = await db.select().from(usageEvents).where(eq(usageEvents.idempotencyKey, idempotencyKey));
    assert.equal(rows.length, 1);

    const total = await getUsageForMeter({ organizationId: org.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    assert.equal(total.quantity, 1);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

// ---------- Authorization middleware ----------

test("requireServiceApplicationMatch allows a credential to act only for its own application", () => {
  const req = fakeReq({
    service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "o1", scopes: [] },
    params: { applicationKey: "NA_PISTA" },
  });
  const captured = captureNext();
  requireServiceApplicationMatch()(req, {} as Response, captured.next);
  assert.equal(captured.error, undefined);
});

test("requireServiceApplicationMatch rejects a credential used against a different application's route", () => {
  const req = fakeReq({
    service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "o1", scopes: [] },
    params: { applicationKey: "MICHA_EXPRESS" },
  });
  const captured = captureNext();
  requireServiceApplicationMatch()(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requireUsageReadAccess allows a service credential with usage.read scoped to the right org+app", () => {
  const req = fakeReq({
    service: {
      apiKeyId: "k1",
      applicationId: "a1",
      applicationKey: "NA_PISTA",
      organizationId: "org-a",
      scopes: ["usage.read"],
    },
    params: { organizationId: "org-a", applicationKey: "NA_PISTA" },
  });
  const captured = captureNext();
  requireUsageReadAccess(req, {} as Response, captured.next);
  assert.equal(captured.error, undefined);
});

test("requireUsageReadAccess rejects a service credential missing usage.read even if org+app match", () => {
  const req = fakeReq({
    service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "org-a", scopes: [] },
    params: { organizationId: "org-a", applicationKey: "NA_PISTA" },
  });
  const captured = captureNext();
  requireUsageReadAccess(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requireUsageReadAccess rejects a service credential scoped to a different organization", () => {
  const req = fakeReq({
    service: {
      apiKeyId: "k1",
      applicationId: "a1",
      applicationKey: "NA_PISTA",
      organizationId: "org-a",
      scopes: ["usage.read"],
    },
    params: { organizationId: "org-b", applicationKey: "NA_PISTA" },
  });
  const captured = captureNext();
  requireUsageReadAccess(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requireUsageReadAccess rejects an unauthenticated request outright", () => {
  const req = fakeReq({ params: { organizationId: "org-a", applicationKey: "NA_PISTA" } });
  const captured = captureNext();
  requireUsageReadAccess(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof UnauthorizedError);
});

// ---------- Tenant & application isolation ----------

test("usage recorded for organization B is never visible when querying organization A", async () => {
  await seed();
  const ownerA = await createTestUser("usage-tenant-a");
  const ownerB = await createTestUser("usage-tenant-b");
  const orgA = await createTestOrganization("usage-tenant-a");
  const orgB = await createTestOrganization("usage-tenant-b");

  try {
    await recordUsage({
      organizationId: orgB.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "10",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    const usageA = await getUsageForMeter({ organizationId: orgA.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    const usageB = await getUsageForMeter({ organizationId: orgB.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    assert.equal(usageA.quantity, 0);
    assert.equal(usageB.quantity, 10);
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("usage recorded for one application is never visible when querying a different application in the same organization", async () => {
  await seed();
  const owner = await createTestUser("usage-app-isolation");
  const org = await createTestOrganization("usage-app-isolation");

  try {
    // api_requests is allowed for both NA_PISTA and MICHA_EXPRESS — a real
    // shared meter key, so this proves data isolation by applicationId,
    // not merely registry/allowlist isolation.
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "api_requests",
      quantity: "50",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    const naPistaUsage = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "api_requests",
    });
    const michaExpressUsage = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "MICHA_EXPRESS",
      meterKey: "api_requests",
    });
    assert.equal(naPistaUsage.quantity, 50);
    assert.equal(michaExpressUsage.quantity, 0);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

// ---------- Aggregation ----------

test("multiple usage events aggregate correctly", async () => {
  await seed();
  const owner = await createTestUser("usage-aggregate");
  const org = await createTestOrganization("usage-aggregate");

  try {
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "2",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "3.5",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "10",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    const total = await getUsageForMeter({ organizationId: org.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    assert.equal(total.quantity, 15.5);

    const perApp = await getUsageForApplication({ organizationId: org.id, applicationKey: "NA_PISTA" });
    const ordersEntry = perApp.meters.find((m) => m.meter.key === "orders");
    assert.equal(ordersEntry?.quantity, 15.5);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a date range excludes events outside it, and an empty period returns zero", async () => {
  await seed();
  const owner = await createTestUser("usage-date-range");
  const org = await createTestOrganization("usage-date-range");

  try {
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "5",
      occurredAt: new Date("2026-01-15T00:00:00Z"),
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "7",
      occurredAt: new Date("2026-03-15T00:00:00Z"),
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    const januaryOnly = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      range: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-31T23:59:59Z") },
    });
    assert.equal(januaryOnly.quantity, 5);

    const wholeQuarter = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      range: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-03-31T23:59:59Z") },
    });
    assert.equal(wholeQuarter.quantity, 12);

    const emptyRange = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      range: { from: new Date("2027-01-01T00:00:00Z"), to: new Date("2027-01-31T23:59:59Z") },
    });
    assert.equal(emptyRange.quantity, 0, "an empty period is a meaningful zero, not an error");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an organization/application with no usage at all returns an empty meter list, not an error", async () => {
  await seed();
  const owner = await createTestUser("usage-empty-app");
  const org = await createTestOrganization("usage-empty-app");

  try {
    const result = await getUsageForApplication({ organizationId: org.id, applicationKey: "NA_PISTA" });
    assert.deepEqual(result.meters, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

// ---------- Lifecycle: usage history survives commercial/application changes ----------

test("historical usage survives subscription cancellation", async () => {
  await seed();
  const owner = await createTestUser("usage-lifecycle-subscription");
  const org = await createTestOrganization("usage-lifecycle-subscription");

  try {
    await recordUsage({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      meterKey: "orders",
      quantity: "4",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    const subscription = await createSubscription({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      planKey: "BUSINESS",
      actorUserId: owner.id,
    });
    await cancelSubscription({ organizationId: org.id, subscriptionId: subscription.id, actorUserId: owner.id });

    const total = await getUsageForMeter({ organizationId: org.id, applicationKey: "NA_PISTA", meterKey: "orders" });
    assert.equal(total.quantity, 4, "canceling the subscription must not touch previously recorded usage");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("historical usage survives the application being suspended", async () => {
  await seed();
  const owner = await createTestUser("usage-lifecycle-app-suspend");
  const org = await createTestOrganization("usage-lifecycle-app-suspend");

  try {
    await recordUsage({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      meterKey: "messages",
      quantity: "9",
      idempotencyKey: `usage_evt_${randomUUID()}`,
    });

    await db.update(applications).set({ status: "SUSPENDED" }).where(eq(applications.key, "QUALE_A_DICA"));

    const total = await getUsageForMeter({
      organizationId: org.id,
      applicationKey: "QUALE_A_DICA",
      meterKey: "messages",
    });
    assert.equal(total.quantity, 9, "suspending the application must not touch or hide previously recorded usage");
  } finally {
    await db.update(applications).set({ status: "ACTIVE" }).where(eq(applications.key, "QUALE_A_DICA"));
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});
