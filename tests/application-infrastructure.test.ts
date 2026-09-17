import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applicationEnvironments, auditLogs } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { createEndpoint, listEndpointsForEnvironment, updateEndpointStatus } from "../src/modules/endpoints/service.js";
import { validateEndpointUrl } from "../src/modules/endpoints/validation.js";
import {
  createEnvironment,
  getEnvironmentDetail,
  getEnvironmentRecord,
  listEnvironmentsForApplication,
  updateEnvironmentStatus,
} from "../src/modules/environments/service.js";
import { getApplicationRecord } from "../src/modules/applications/service.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/shared/errors.js";

after(() => queryClient.end());

// ---------- Environments ----------

test("environments are seeded for real product applications", async () => {
  await seed();
  const envs = await listEnvironmentsForApplication("NA_PISTA");
  const keys = envs.map((e) => e.key);
  assert.ok(keys.includes("production"));
  assert.ok(keys.includes("staging"));
  assert.ok(envs.every((e) => e.status === "ACTIVE"));
});

test("createEnvironment persists a new environment and getEnvironmentDetail reads it back", async () => {
  await seed();
  const key = `test_env_${randomUUID().slice(0, 8)}`;

  try {
    const created = await createEnvironment({ applicationKey: "FOI", key });
    assert.equal(created.application, "FOI");
    assert.equal(created.key, key);
    assert.equal(created.status, "ACTIVE");

    const detail = await getEnvironmentDetail("FOI", key);
    assert.deepEqual(detail, created);
  } finally {
    const application = await getApplicationRecord("FOI");
    const row = await getEnvironmentRecord(application.id, key);
    await db.delete(applicationEnvironments).where(eq(applicationEnvironments.id, row.id));
  }
});

test("creating a duplicate environment for the same application is rejected", async () => {
  await seed();
  await assert.rejects(() => createEnvironment({ applicationKey: "NA_PISTA", key: "production" }), ConflictError);
});

test("environment keys under different applications never collide", async () => {
  await seed();
  const naPistaProd = await getEnvironmentDetail("NA_PISTA", "production");
  const michaExpressProd = await getEnvironmentDetail("MICHA_EXPRESS", "production");
  assert.equal(naPistaProd.application, "NA_PISTA");
  assert.equal(michaExpressProd.application, "MICHA_EXPRESS");
});

test("updateEnvironmentStatus can deactivate and reactivate an environment, and is audited", async () => {
  await seed();
  const updated = await updateEnvironmentStatus({
    applicationKey: "FOI",
    environmentKey: "staging",
    status: "INACTIVE",
  });
  try {
    assert.equal(updated.status, "INACTIVE");

    const detail = await getEnvironmentDetail("FOI", "staging");
    assert.equal(detail.status, "INACTIVE");

    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "environment.updated"));
    assert.ok(events.length > 0);
  } finally {
    await updateEnvironmentStatus({ applicationKey: "FOI", environmentKey: "staging", status: "ACTIVE" });
  }
});

test("getEnvironmentDetail 404s for an unknown environment key", async () => {
  await seed();
  await assert.rejects(() => getEnvironmentDetail("NA_PISTA", "not_a_real_environment"), NotFoundError);
});

// ---------- Endpoint URL validation ----------

test("validateEndpointUrl accepts HTTPS everywhere and HTTP outside production", () => {
  assert.doesNotThrow(() => validateEndpointUrl("https://api.example.com", "production"));
  assert.doesNotThrow(() => validateEndpointUrl("http://localhost:4000", "staging"));
});

test("validateEndpointUrl rejects HTTP in production", () => {
  assert.throws(() => validateEndpointUrl("http://api.example.com", "production"), ValidationError);
});

test("validateEndpointUrl rejects a malformed URL", () => {
  assert.throws(() => validateEndpointUrl("not-a-url", "staging"), ValidationError);
});

test("validateEndpointUrl rejects embedded credentials", () => {
  assert.throws(() => validateEndpointUrl("https://user:password@example.com", "staging"), ValidationError);
});

test("validateEndpointUrl rejects a URL fragment", () => {
  assert.throws(() => validateEndpointUrl("https://example.com/api#fragment", "staging"), ValidationError);
});

// ---------- Endpoints ----------

test("creating an endpoint validates its URL against its own environment and persists it", async () => {
  await seed();
  const key = `test_env_${randomUUID().slice(0, 8)}`;
  await createEnvironment({ applicationKey: "FOI", key });

  try {
    const created = await createEndpoint({
      applicationKey: "FOI",
      environmentKey: key,
      type: "API",
      baseUrl: "http://localhost:5001",
    });
    assert.equal(created.type, "API");
    assert.equal(created.baseUrl, "http://localhost:5001");
    assert.equal(created.status, "ACTIVE");

    const endpoints = await listEndpointsForEnvironment("FOI", key);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0]?.baseUrl, "http://localhost:5001");
  } finally {
    const application = await getApplicationRecord("FOI");
    const row = await getEnvironmentRecord(application.id, key);
    await db.delete(applicationEnvironments).where(eq(applicationEnvironments.id, row.id));
  }
});

test("creating an endpoint rejects an insecure URL for a production environment", async () => {
  await seed();
  await assert.rejects(
    () =>
      createEndpoint({
        applicationKey: "NA_PISTA",
        environmentKey: "production",
        type: "API",
        baseUrl: "http://insecure.example.com",
      }),
    ValidationError,
  );
});

test("creating a duplicate endpoint type for the same environment is rejected", async () => {
  await seed();
  // NA_PISTA/staging already has a seeded API endpoint
  await assert.rejects(
    () =>
      createEndpoint({
        applicationKey: "NA_PISTA",
        environmentKey: "staging",
        type: "API",
        baseUrl: "https://another-staging.na-pista.example",
      }),
    ConflictError,
  );
});

test("creating an endpoint for an unknown environment is rejected", async () => {
  await seed();
  await assert.rejects(
    () =>
      createEndpoint({
        applicationKey: "NA_PISTA",
        environmentKey: "not_a_real_environment",
        type: "API",
        baseUrl: "https://example.com",
      }),
    NotFoundError,
  );
});

test("endpoints under one application's environment are never visible under a different application", async () => {
  await seed();
  const naPistaEndpoints = await listEndpointsForEnvironment("NA_PISTA", "staging");
  const michaExpressEndpoints = await listEndpointsForEnvironment("MICHA_EXPRESS", "staging");
  assert.ok(naPistaEndpoints.some((e) => e.baseUrl.includes("na-pista")));
  assert.ok(!michaExpressEndpoints.some((e) => e.baseUrl.includes("na-pista")));
});

test("updateEndpointStatus can deactivate an endpoint, and is audited", async () => {
  await seed();
  const key = `test_env_${randomUUID().slice(0, 8)}`;
  await createEnvironment({ applicationKey: "FOI", key });
  await createEndpoint({ applicationKey: "FOI", environmentKey: key, type: "API", baseUrl: "http://localhost:5002" });

  try {
    const updated = await updateEndpointStatus({
      applicationKey: "FOI",
      environmentKey: key,
      type: "API",
      status: "INACTIVE",
    });
    assert.equal(updated.status, "INACTIVE");

    const events = await db.select().from(auditLogs).where(eq(auditLogs.action, "endpoint.updated"));
    assert.ok(events.length > 0);
  } finally {
    const application = await getApplicationRecord("FOI");
    const row = await getEnvironmentRecord(application.id, key);
    await db.delete(applicationEnvironments).where(eq(applicationEnvironments.id, row.id));
  }
});
