import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { createOrganizationApiKey, revokeApiKey, verifyApiKeyToken } from "../src/modules/apiKeys/service.js";
import {
  listApplicationServiceScopes,
  listServiceScopes,
  serviceCredentialHasScope,
  validateRequestedScopes,
} from "../src/modules/serviceScopes/service.js";
import { requireServiceScope } from "../src/middleware/requireServiceScope.js";
import { requireServiceOrganizationMatch } from "../src/middleware/requireServiceOrganizationMatch.js";
import { requirePermission } from "../src/middleware/requirePermission.js";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

async function getApplicationId(key: string): Promise<string> {
  const [row] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, key));
  return row!.id;
}

/** Minimal Request/Response stand-ins — these middlewares only read req.service/req.auth/req.params and call next(). */
function fakeReq(overrides: Partial<Request>): Request {
  return { params: {}, ...overrides } as unknown as Request;
}

function captureNext(): { next: (error?: unknown) => void; error: unknown; called: boolean } {
  const state = { next: (() => {}) as (error?: unknown) => void, error: undefined as unknown, called: false };
  state.next = (error?: unknown) => {
    state.called = true;
    state.error = error;
  };
  return state;
}

test("the service scope registry is seeded with the platform's generic scope vocabulary", async () => {
  await seed();
  const scopes = await listServiceScopes();
  const keys = scopes.map((s) => s.key);
  assert.ok(keys.includes("event.publish"));
  assert.ok(keys.includes("catalog.read"));
  assert.ok(keys.includes("payment.create"));
});

test("an application's allowed scopes are a strict subset of the registry", async () => {
  await seed();
  const naPista = await listApplicationServiceScopes("NA_PISTA");
  const naPistaKeys = naPista.scopes.map((s) => s.key);
  assert.ok(naPistaKeys.includes("catalog.read"));
  assert.ok(!naPistaKeys.includes("payment.create"), "NA_PISTA must not be allowed a MICHA_EXPRESS-only scope");

  const michaExpress = await listApplicationServiceScopes("MICHA_EXPRESS");
  const michaExpressKeys = michaExpress.scopes.map((s) => s.key);
  assert.ok(michaExpressKeys.includes("payment.create"));
  assert.ok(!michaExpressKeys.includes("catalog.write"), "MICHA_EXPRESS must not be allowed a NA_PISTA-only scope");
});

test("validateRequestedScopes rejects a scope key that doesn't exist anywhere in the registry", async () => {
  await seed();
  const naPistaId = await getApplicationId("NA_PISTA");
  await assert.rejects(
    () => validateRequestedScopes(naPistaId, "NA_PISTA", ["admin.everything"]),
    ValidationError,
    "a client must never be able to invent a scope merely by typing a new string",
  );
});

test("validateRequestedScopes rejects a real scope that this application is not authorized for", async () => {
  await seed();
  const naPistaId = await getApplicationId("NA_PISTA");
  await assert.rejects(
    () => validateRequestedScopes(naPistaId, "NA_PISTA", ["payment.create"]),
    ForbiddenError,
    "a registered-but-cross-application scope must be a 403, not a 400",
  );
});

test("validateRequestedScopes accepts and resolves an allowed scope set, de-duplicated", async () => {
  await seed();
  const naPistaId = await getApplicationId("NA_PISTA");
  const resolved = await validateRequestedScopes(naPistaId, "NA_PISTA", ["catalog.read", "catalog.read"]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.key, "catalog.read");
});

test("creating an API key with valid, allowed scopes persists and returns exactly those scopes", async () => {
  await seed();
  const owner = await createTestUser("scopes-create-valid");
  const org = await createTestOrganization("scopes-create-valid");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
      scopes: ["event.publish", "catalog.read"],
    });
    assert.deepEqual([...created.scopes].sort(), ["catalog.read", "event.publish"]);

    const verified = await verifyApiKeyToken(created.secret);
    assert.deepEqual([...verified.scopes].sort(), ["catalog.read", "event.publish"]);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("creating an API key without a scopes field grants no scopes — a valid, empty-by-default state", async () => {
  await seed();
  const owner = await createTestUser("scopes-create-none");
  const org = await createTestOrganization("scopes-create-none");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
    });
    assert.deepEqual(created.scopes, []);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("creating an API key with an unknown scope fails and persists nothing", async () => {
  await seed();
  const owner = await createTestUser("scopes-create-unknown");
  const org = await createTestOrganization("scopes-create-unknown");

  try {
    await assert.rejects(
      () =>
        createOrganizationApiKey({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          actorUserId: owner.id,
          scopes: ["admin.everything"],
        }),
      ValidationError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("creating an API key with a cross-application scope fails, even though the scope itself is real", async () => {
  await seed();
  const owner = await createTestUser("scopes-create-cross-app");
  const org = await createTestOrganization("scopes-create-cross-app");

  try {
    await assert.rejects(
      () =>
        createOrganizationApiKey({
          organizationId: org.id,
          applicationKey: "NA_PISTA",
          actorUserId: owner.id,
          scopes: ["payment.create"], // real scope, but MICHA_EXPRESS-only
        }),
      ForbiddenError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("serviceCredentialHasScope reflects exactly the granted set, nothing more", async () => {
  await seed();
  const owner = await createTestUser("scopes-has-scope");
  const org = await createTestOrganization("scopes-has-scope");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
      scopes: ["catalog.read"],
    });

    assert.equal(await serviceCredentialHasScope(created.id, "catalog.read"), true);
    assert.equal(await serviceCredentialHasScope(created.id, "catalog.write"), false);
    assert.equal(await serviceCredentialHasScope(created.id, "payment.create"), false);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("a revoked API key's granted scopes can no longer authenticate at all", async () => {
  await seed();
  const owner = await createTestUser("scopes-revoked");
  const org = await createTestOrganization("scopes-revoked");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
      scopes: ["catalog.read"],
    });
    await revokeApiKey({ organizationId: org.id, keyId: created.id, actorUserId: owner.id });

    await assert.rejects(() => verifyApiKeyToken(created.secret), UnauthorizedError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("an expired API key's granted scopes can no longer authenticate at all", async () => {
  await seed();
  const owner = await createTestUser("scopes-expired");
  const org = await createTestOrganization("scopes-expired");

  try {
    const created = await createOrganizationApiKey({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      actorUserId: owner.id,
      scopes: ["catalog.read"],
      expiresAt: new Date(Date.now() - 60_000),
    });

    await assert.rejects(() => verifyApiKeyToken(created.secret), UnauthorizedError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("requireServiceScope lets a request through when the credential holds the scope", () => {
  const req = fakeReq({ service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "o1", scopes: ["catalog.read"] } });
  const captured = captureNext();
  requireServiceScope("catalog.read")(req, {} as Response, captured.next);
  assert.equal(captured.called, true);
  assert.equal(captured.error, undefined);
});

test("requireServiceScope rejects a request whose credential lacks the scope", () => {
  const req = fakeReq({ service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "o1", scopes: ["catalog.read"] } });
  const captured = captureNext();
  requireServiceScope("catalog.write")(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requireServiceScope rejects a human request outright — human and service authorization are never conflated", () => {
  const req = fakeReq({ auth: { userId: "u1", email: undefined } });
  const captured = captureNext();
  requireServiceScope("catalog.read")(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requirePermission rejects a service credential outright — it has no membership to check a permission against", async () => {
  const req = fakeReq({ service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "o1", scopes: [] } });
  const captured = captureNext();
  await requirePermission("organization.read")(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof UnauthorizedError);
});

test("requireServiceOrganizationMatch allows a credential to act only in its own stored organization", () => {
  const req = fakeReq({
    service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "org-a", scopes: [] },
    params: { organizationId: "org-a" },
  });
  const captured = captureNext();
  requireServiceOrganizationMatch()(req, {} as Response, captured.next);
  assert.equal(captured.error, undefined);
});

test("requireServiceOrganizationMatch rejects a credential used against a different organization's route", () => {
  const req = fakeReq({
    service: { apiKeyId: "k1", applicationId: "a1", applicationKey: "NA_PISTA", organizationId: "org-a", scopes: [] },
    params: { organizationId: "org-b" },
  });
  const captured = captureNext();
  requireServiceOrganizationMatch()(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof ForbiddenError);
});

test("requireServiceOrganizationMatch rejects a human request outright — no service credential to match", () => {
  const req = fakeReq({ auth: { userId: "u1", email: undefined }, params: { organizationId: "org-a" } });
  const captured = captureNext();
  requireServiceOrganizationMatch()(req, {} as Response, captured.next);
  assert.ok(captured.error instanceof UnauthorizedError);
});
