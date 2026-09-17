import assert from "node:assert/strict";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applicationIntegrations, auditLogs } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { getApplicationRecord } from "../src/modules/applications/service.js";
import { discoverService } from "../src/modules/discovery/service.js";
import { updateEndpointStatus } from "../src/modules/endpoints/service.js";
import { updateEnvironmentStatus } from "../src/modules/environments/service.js";
import {
  createIntegration,
  getIntegrationDetail,
  listIntegrationsForSource,
  updateIntegrationStatus,
} from "../src/modules/integrations/service.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/shared/errors.js";

after(() => queryClient.end());

// ---------- Integrations ----------

test("integrations are seeded exactly as directional examples", async () => {
  await seed();
  const detail = await getIntegrationDetail("QUALE_A_DICA", "NA_PISTA");
  assert.equal(detail.source, "QUALE_A_DICA");
  assert.equal(detail.target, "NA_PISTA");
  assert.equal(detail.status, "ACTIVE");
});

test("an integration A→B does not imply B→A", async () => {
  await seed();
  await assert.rejects(() => getIntegrationDetail("NA_PISTA", "QUALE_A_DICA"), NotFoundError);
});

test("creating a duplicate directional integration is rejected", async () => {
  await seed();
  await assert.rejects(() => createIntegration({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA" }), ConflictError);
});

test("the reverse direction of an existing integration can still be created as its own distinct row", async () => {
  await seed();
  const reverse = await createIntegration({ sourceApplicationKey: "NA_PISTA", targetApplicationKey: "QUALE_A_DICA" });
  try {
    assert.equal(reverse.source, "NA_PISTA");
    assert.equal(reverse.target, "QUALE_A_DICA");

    const forward = await getIntegrationDetail("QUALE_A_DICA", "NA_PISTA");
    assert.equal(forward.source, "QUALE_A_DICA");
  } finally {
    const naPista = await getApplicationRecord("NA_PISTA");
    const qualeADica = await getApplicationRecord("QUALE_A_DICA");
    await db
      .delete(applicationIntegrations)
      .where(
        and(
          eq(applicationIntegrations.sourceApplicationId, naPista.id),
          eq(applicationIntegrations.targetApplicationId, qualeADica.id),
        ),
      );
  }
});

test("an application cannot be integrated with itself", async () => {
  await seed();
  await assert.rejects(
    () => createIntegration({ sourceApplicationKey: "NA_PISTA", targetApplicationKey: "NA_PISTA" }),
    ValidationError,
  );
});

test("creating an integration with an unknown target application is rejected", async () => {
  await seed();
  await assert.rejects(
    () => createIntegration({ sourceApplicationKey: "NA_PISTA", targetApplicationKey: "NOT_A_REAL_APP" }),
    NotFoundError,
  );
});

test("listIntegrationsForSource only returns that source's own outgoing integrations", async () => {
  await seed();
  const list = await listIntegrationsForSource("QUALE_A_DICA");
  assert.ok(list.some((i) => i.target === "NA_PISTA"));
  assert.ok(!list.some((i) => i.target === "QUALE_A_DICA"));
});

test("integration creation is audited", async () => {
  await seed();
  const created = await createIntegration({ sourceApplicationKey: "FOI", targetApplicationKey: "HOJE_TEM" });
  try {
    assert.equal(created.source, "FOI");
    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "integration.created"));
    assert.ok(events.length > 0);
  } finally {
    const foi = await getApplicationRecord("FOI");
    const hojeTem = await getApplicationRecord("HOJE_TEM");
    await db
      .delete(applicationIntegrations)
      .where(and(eq(applicationIntegrations.sourceApplicationId, foi.id), eq(applicationIntegrations.targetApplicationId, hojeTem.id)));
  }
});

test("integration status updates are audited", async () => {
  await seed();
  const updated = await updateIntegrationStatus({
    sourceApplicationKey: "HOJE_TEM",
    targetApplicationKey: "QUALE_A_DICA",
    status: "INACTIVE",
  });
  try {
    assert.equal(updated.status, "INACTIVE");
    const updateEvents = await db.select().from(auditLogs).where(eq(auditLogs.action, "integration.updated"));
    assert.ok(updateEvents.length > 0);
  } finally {
    await updateIntegrationStatus({ sourceApplicationKey: "HOJE_TEM", targetApplicationKey: "QUALE_A_DICA", status: "ACTIVE" });
  }
});

// ---------- Service Discovery ----------

test("a valid, fully-active chain resolves to the target's endpoint, with no secrets or organization context", async () => {
  await seed();
  const result = await discoverService({
    sourceApplicationKey: "QUALE_A_DICA",
    targetApplicationKey: "NA_PISTA",
    environmentKey: "staging",
  });

  assert.deepEqual(result, {
    application: { key: "NA_PISTA" },
    environment: "staging",
    endpoint: { type: "API", baseUrl: "https://staging.na-pista.example" },
  });

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.toLowerCase().includes("secret"));
  assert.ok(!("organizationId" in result));
});

test("discovery rejects an unknown target application", async () => {
  await seed();
  await assert.rejects(
    () =>
      discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NOT_A_REAL_APP", environmentKey: "staging" }),
    NotFoundError,
  );
});

test("discovery rejects an unknown environment", async () => {
  await seed();
  await assert.rejects(
    () =>
      discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", environmentKey: "not_a_real_env" }),
    NotFoundError,
  );
});

test("discovery rejects a target with no registered ACTIVE integration from this source", async () => {
  await seed();
  // NA_PISTA has no integration *from* MICHA_EXPRESS in the seed
  await assert.rejects(
    () =>
      discoverService({ sourceApplicationKey: "MICHA_EXPRESS", targetApplicationKey: "NA_PISTA", environmentKey: "staging" }),
    ForbiddenError,
  );
});

test("discovery rejects when the integration exists but is INACTIVE", async () => {
  await seed();
  await updateIntegrationStatus({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", status: "INACTIVE" });
  try {
    await assert.rejects(
      () =>
        discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", environmentKey: "staging" }),
      ForbiddenError,
    );
  } finally {
    await updateIntegrationStatus({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", status: "ACTIVE" });
  }
});

test("discovery rejects when the environment exists but is INACTIVE", async () => {
  await seed();
  await updateEnvironmentStatus({ applicationKey: "NA_PISTA", environmentKey: "staging", status: "INACTIVE" });
  try {
    await assert.rejects(
      () =>
        discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", environmentKey: "staging" }),
      NotFoundError,
    );
  } finally {
    await updateEnvironmentStatus({ applicationKey: "NA_PISTA", environmentKey: "staging", status: "ACTIVE" });
  }
});

test("discovery rejects when the endpoint exists but is INACTIVE", async () => {
  await seed();
  await updateEndpointStatus({ applicationKey: "NA_PISTA", environmentKey: "staging", type: "API", status: "INACTIVE" });
  try {
    await assert.rejects(
      () =>
        discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", environmentKey: "staging" }),
      NotFoundError,
    );
  } finally {
    await updateEndpointStatus({ applicationKey: "NA_PISTA", environmentKey: "staging", type: "API", status: "ACTIVE" });
  }
});

test("discovery rejects a target application with no endpoint configured for the requested environment", async () => {
  await seed();
  // NA_PISTA has no seeded "production" endpoint at all
  await assert.rejects(
    () =>
      discoverService({ sourceApplicationKey: "QUALE_A_DICA", targetApplicationKey: "NA_PISTA", environmentKey: "production" }),
    NotFoundError,
  );
});

test("cross-application misuse: an application not registered as a source cannot discover anything for that target", async () => {
  await seed();
  await assert.rejects(
    () =>
      discoverService({ sourceApplicationKey: "FOI", targetApplicationKey: "MICHA_EXPRESS", environmentKey: "staging" }),
    ForbiddenError,
  );
});
