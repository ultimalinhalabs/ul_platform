import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, auditLogs, webhookDeliveries, webhookEndpoints } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { encryptWebhookSecret } from "../src/modules/webhooks/crypto.js";
import { deliverWebhook, publishEvent } from "../src/modules/webhooks/delivery.js";
import { createWebhookEndpointSchema } from "../src/modules/webhooks/schemas.js";
import {
  createWebhookEndpoint,
  getWebhookEndpointDetail,
  listWebhookEndpointsForOrganization,
  revokeWebhookEndpoint,
  testWebhookEndpoint,
} from "../src/modules/webhooks/service.js";
import { signWebhookPayload, verifyWebhookSignature } from "../src/modules/webhooks/signature.js";
import { ConflictError, NotFoundError } from "../src/shared/errors.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A minimal local receiver — enough to independently verify what the platform actually sent over the wire. */
function startReceiver(status = 200): Promise<{ server: http.Server; url: string; received: CapturedRequest[] }> {
  const received: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, received });
    });
  });
}

/**
 * `deliverWebhook` is a pure delivery primitive that expects a genuinely
 * persisted endpoint (webhook_deliveries.webhook_endpoint_id is a real,
 * NOT NULL foreign key — there's no such thing as delivering "for" an
 * endpoint that doesn't exist). These direct-`deliverWebhook` tests need a
 * real row with a known plaintext secret, without going through
 * `createWebhookEndpoint`'s own secret generation.
 */
async function insertRawWebhookEndpoint(input: { organizationId: string; url: string; secret: string }) {
  const [application] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, "NA_PISTA"));
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      applicationId: application!.id,
      organizationId: input.organizationId,
      url: input.url,
      secretEncrypted: encryptWebhookSecret(input.secret),
    })
    .returning();
  return row!;
}

// ---------- Management: create / list / get / revoke ----------

test("creating a webhook endpoint validates the application and returns the secret exactly once", async () => {
  await seed();
  const owner = await createTestUser("webhook-create");
  const org = await createTestOrganization("webhook-create");

  try {
    const created = await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: "https://example.test/hook",
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });

    assert.equal(created.application, "NA_PISTA");
    assert.equal(created.status, "ACTIVE");
    assert.deepEqual(created.eventTypes, ["order.created"]);
    assert.ok(created.secret.startsWith("whsec_"));

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.id));
    assert.ok(row);
    assert.notEqual(row?.secretEncrypted, created.secret);
    assert.ok(!row?.secretEncrypted.includes(created.secret));
    assert.equal((row as unknown as { secret?: unknown }).secret, undefined);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("creating a webhook endpoint for an unknown application is rejected", async () => {
  await seed();
  const owner = await createTestUser("webhook-unknown-app");
  const org = await createTestOrganization("webhook-unknown-app");

  try {
    await assert.rejects(
      () =>
        createWebhookEndpoint({
          organizationId: org.id,
          applicationKey: "NOT_A_REAL_APP",
          url: "https://example.test/hook",
          eventTypes: ["order.created"],
          actorUserId: owner.id,
        }),
      NotFoundError,
    );
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("event type subscriptions must follow the domain.action convention and cannot be empty", () => {
  const missingEventTypes = createWebhookEndpointSchema.safeParse({
    applicationKey: "NA_PISTA",
    url: "https://example.test/hook",
    eventTypes: [],
  });
  assert.equal(missingEventTypes.success, false);

  const malformedEventType = createWebhookEndpointSchema.safeParse({
    applicationKey: "NA_PISTA",
    url: "https://example.test/hook",
    eventTypes: ["not-a-valid-event-type"],
  });
  assert.equal(malformedEventType.success, false);

  const validPayload = createWebhookEndpointSchema.safeParse({
    applicationKey: "NA_PISTA",
    url: "https://example.test/hook",
    eventTypes: ["order.created", "order.canceled"],
  });
  assert.equal(validPayload.success, true);
});

test("listWebhookEndpointsForOrganization and getWebhookEndpointDetail are tenant-scoped", async () => {
  await seed();
  const ownerA = await createTestUser("webhook-tenant-a");
  const ownerB = await createTestUser("webhook-tenant-b");
  const orgA = await createTestOrganization("webhook-tenant-a");
  const orgB = await createTestOrganization("webhook-tenant-b");

  try {
    const endpointA = await createWebhookEndpoint({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      url: "https://example.test/a",
      eventTypes: ["order.created"],
      actorUserId: ownerA.id,
    });
    await createWebhookEndpoint({
      organizationId: orgB.id,
      applicationKey: "FOI",
      url: "https://example.test/b",
      eventTypes: ["delivery.completed"],
      actorUserId: ownerB.id,
    });

    const listA = await listWebhookEndpointsForOrganization(orgA.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.id, endpointA.id);

    await assert.rejects(() => getWebhookEndpointDetail(orgB.id, endpointA.id), NotFoundError);

    const detail = await getWebhookEndpointDetail(orgA.id, endpointA.id);
    assert.equal(detail.id, endpointA.id);
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("revoking a webhook endpoint cannot be done through another organization's context, and cannot be repeated", async () => {
  await seed();
  const ownerA = await createTestUser("webhook-revoke-tenant-a");
  const ownerB = await createTestUser("webhook-revoke-tenant-b");
  const orgA = await createTestOrganization("webhook-revoke-tenant-a");
  const orgB = await createTestOrganization("webhook-revoke-tenant-b");

  try {
    const endpointA = await createWebhookEndpoint({
      organizationId: orgA.id,
      applicationKey: "NA_PISTA",
      url: "https://example.test/a",
      eventTypes: ["order.created"],
      actorUserId: ownerA.id,
    });

    await assert.rejects(
      () => revokeWebhookEndpoint({ organizationId: orgB.id, webhookId: endpointA.id, actorUserId: ownerB.id }),
      NotFoundError,
    );

    const revoked = await revokeWebhookEndpoint({
      organizationId: orgA.id,
      webhookId: endpointA.id,
      actorUserId: ownerA.id,
    });
    assert.equal(revoked.status, "REVOKED");

    await assert.rejects(
      () => revokeWebhookEndpoint({ organizationId: orgA.id, webhookId: endpointA.id, actorUserId: ownerA.id }),
      ConflictError,
    );
  } finally {
    await deleteTestOrganization(orgA.id);
    await deleteTestOrganization(orgB.id);
    await deleteTestUser(ownerA.id);
    await deleteTestUser(ownerB.id);
  }
});

test("webhook creation and revocation are audited, and no secret material ever appears in the audit log", async () => {
  await seed();
  const owner = await createTestUser("webhook-audit");
  const org = await createTestOrganization("webhook-audit");

  try {
    const created = await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: "https://example.test/hook",
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });
    await revokeWebhookEndpoint({ organizationId: org.id, webhookId: created.id, actorUserId: owner.id });

    const events = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "webhook_endpoint"), eq(auditLogs.targetId, created.id)));

    assert.deepEqual(
      events.map((e) => e.action).sort(),
      ["webhook.created", "webhook.revoked"],
    );

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(created.secret), "raw webhook secret must never reach the audit log");
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

// ---------- Signature ----------

test("verifyWebhookSignature accepts a signature this platform actually produced", () => {
  const secret = "whsec_test-secret";
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ hello: "world" });
  const signature = signWebhookPayload(secret, timestamp, rawBody);

  assert.equal(verifyWebhookSignature({ secret, timestamp, rawBody, signature }), true);
});

test("verifyWebhookSignature rejects a tampered body, a wrong secret, and a malformed signature", () => {
  const secret = "whsec_test-secret";
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ hello: "world" });
  const signature = signWebhookPayload(secret, timestamp, rawBody);

  assert.equal(
    verifyWebhookSignature({ secret, timestamp, rawBody: JSON.stringify({ hello: "tampered" }), signature }),
    false,
  );
  assert.equal(verifyWebhookSignature({ secret: "whsec_wrong-secret", timestamp, rawBody, signature }), false);
  assert.equal(verifyWebhookSignature({ secret, timestamp, rawBody, signature: "not-hex-garbage!!" }), false);
});

test("verifyWebhookSignature rejects a stale timestamp outside the tolerance window — replay protection", () => {
  const secret = "whsec_test-secret";
  const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000; // far outside any reasonable tolerance
  const rawBody = JSON.stringify({ hello: "world" });
  const signature = signWebhookPayload(secret, staleTimestamp, rawBody);

  assert.equal(
    verifyWebhookSignature({ secret, timestamp: staleTimestamp, rawBody, signature, toleranceSeconds: 300 }),
    false,
  );
});

// ---------- Delivery ----------

test("deliverWebhook POSTs a signed envelope and records a SUCCESS delivery matching what was actually sent", async () => {
  await seed();
  const owner = await createTestUser("deliver-success");
  const org = await createTestOrganization("deliver-success");
  const { server, url, received } = await startReceiver(200);
  const secret = "whsec_direct-delivery-test";

  try {
    const endpoint = await insertRawWebhookEndpoint({ organizationId: org.id, url, secret });

    const result = await deliverWebhook({
      endpoint: { id: endpoint.id, url, secretEncrypted: endpoint.secretEncrypted },
      event: {
        id: "evt_test-1",
        type: "order.created",
        source: { application: "NA_PISTA" },
        organizationId: org.id,
        occurredAt: new Date().toISOString(),
        data: { orderId: "abc" },
      },
    });

    assert.equal(result.status, "SUCCESS");
    assert.equal(result.responseStatus, 200);
    assert.equal(received.length, 1);

    const req = received[0]!;
    assert.equal(req.headers["x-ul-event-id"], "evt_test-1");
    assert.equal(req.headers["x-ul-event-type"], "order.created");
    const timestamp = Number(req.headers["x-ul-timestamp"]);
    const signature = String(req.headers["x-ul-signature"]);
    assert.equal(verifyWebhookSignature({ secret, timestamp, rawBody: req.body, signature }), true);

    const envelope = JSON.parse(req.body);
    assert.equal(envelope.source.application, "NA_PISTA");
    assert.equal(envelope.type, "order.created");

    const [deliveryRow] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookEndpointId, endpoint.id));
    assert.equal(deliveryRow?.status, "SUCCESS");
    assert.equal(deliveryRow?.responseStatus, 200);
  } finally {
    server.close();
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("deliverWebhook records FAILED with the real response status when the receiver rejects the request", async () => {
  await seed();
  const owner = await createTestUser("deliver-failure-status");
  const org = await createTestOrganization("deliver-failure-status");
  const { server, url } = await startReceiver(500);
  const secret = "whsec_failure-status-test";

  try {
    const endpoint = await insertRawWebhookEndpoint({ organizationId: org.id, url, secret });

    const result = await deliverWebhook({
      endpoint: { id: endpoint.id, url, secretEncrypted: endpoint.secretEncrypted },
      event: {
        id: "evt_test-2",
        type: "order.created",
        source: { application: "NA_PISTA" },
        organizationId: org.id,
        occurredAt: new Date().toISOString(),
        data: {},
      },
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.responseStatus, 500);
  } finally {
    server.close();
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("deliverWebhook records FAILED with a null response status when the endpoint is unreachable, and never throws", async () => {
  await seed();
  const owner = await createTestUser("deliver-unreachable");
  const org = await createTestOrganization("deliver-unreachable");
  const secret = "whsec_unreachable-test";

  try {
    const endpoint = await insertRawWebhookEndpoint({
      organizationId: org.id,
      url: "http://127.0.0.1:1/unreachable",
      secret,
    });

    const result = await deliverWebhook({
      endpoint: { id: endpoint.id, url: endpoint.url, secretEncrypted: endpoint.secretEncrypted },
      event: {
        id: "evt_test-3",
        type: "order.created",
        source: { application: "NA_PISTA" },
        organizationId: org.id,
        occurredAt: new Date().toISOString(),
        data: {},
      },
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.responseStatus, null);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

// ---------- publishEvent: subscription routing, tenant isolation, idempotency metadata ----------

test("publishEvent delivers only to ACTIVE endpoints subscribed to that exact event type, in that organization", async () => {
  await seed();
  const owner = await createTestUser("publish-routing");
  const org = await createTestOrganization("publish-routing");
  const otherOrg = await createTestOrganization("publish-routing-other");
  const subscribed = await startReceiver(200);
  const unsubscribed = await startReceiver(200);
  const otherOrgReceiver = await startReceiver(200);

  try {
    await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: subscribed.url,
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });
    await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: unsubscribed.url,
      eventTypes: ["order.canceled"], // different event type — must not receive order.created
      actorUserId: owner.id,
    });
    await createWebhookEndpoint({
      organizationId: otherOrg.id,
      applicationKey: "NA_PISTA",
      url: otherOrgReceiver.url,
      eventTypes: ["order.created"], // same event type, different org — must not receive this org's event
      actorUserId: owner.id,
    });

    const result = await publishEvent({
      organizationId: org.id,
      sourceApplicationKey: "NA_PISTA",
      type: "order.created",
      data: { orderId: "xyz" },
    });

    assert.equal(result.deliveries, 1);
    assert.equal(subscribed.received.length, 1);
    assert.equal(unsubscribed.received.length, 0);
    assert.equal(otherOrgReceiver.received.length, 0);

    const envelope = JSON.parse(subscribed.received[0]!.body);
    assert.equal(envelope.organizationId, org.id);
    assert.equal(envelope.source.application, "NA_PISTA");
    assert.ok(envelope.id.startsWith("evt_"));
  } finally {
    subscribed.server.close();
    unsubscribed.server.close();
    otherOrgReceiver.server.close();
    await deleteTestOrganization(org.id);
    await deleteTestOrganization(otherOrg.id);
    await deleteTestUser(owner.id);
  }
});

test("a revoked endpoint receives nothing, even if it remains subscribed to the event type", async () => {
  await seed();
  const owner = await createTestUser("publish-revoked-endpoint");
  const org = await createTestOrganization("publish-revoked-endpoint");
  const receiver = await startReceiver(200);

  try {
    const endpoint = await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: receiver.url,
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });
    await revokeWebhookEndpoint({ organizationId: org.id, webhookId: endpoint.id, actorUserId: owner.id });

    const result = await publishEvent({
      organizationId: org.id,
      sourceApplicationKey: "NA_PISTA",
      type: "order.created",
      data: {},
    });

    assert.equal(result.deliveries, 0);
    assert.equal(receiver.received.length, 0);
  } finally {
    receiver.server.close();
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("each publish gets a unique event id — duplicate delivery is a consumer-side idempotency concern, not prevented at publish time", async () => {
  await seed();
  const owner = await createTestUser("publish-event-id");
  const org = await createTestOrganization("publish-event-id");
  const receiver = await startReceiver(200);

  try {
    await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: receiver.url,
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });

    const first = await publishEvent({
      organizationId: org.id,
      sourceApplicationKey: "NA_PISTA",
      type: "order.created",
      data: {},
    });
    const second = await publishEvent({
      organizationId: org.id,
      sourceApplicationKey: "NA_PISTA",
      type: "order.created",
      data: {},
    });

    assert.notEqual(first.eventId, second.eventId);
    assert.equal(receiver.received.length, 2);

    const deliveryRows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, first.eventId));
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0]?.status, "SUCCESS");
  } finally {
    receiver.server.close();
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("testWebhookEndpoint bypasses subscriptions and delivers a synthetic event to exactly this endpoint", async () => {
  await seed();
  const owner = await createTestUser("webhook-test-endpoint");
  const org = await createTestOrganization("webhook-test-endpoint");
  const receiver = await startReceiver(200);

  try {
    const endpoint = await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: receiver.url,
      eventTypes: ["order.created"], // deliberately NOT "webhook.test" — the test call must still land
      actorUserId: owner.id,
    });

    const result = await testWebhookEndpoint({ organizationId: org.id, webhookId: endpoint.id });
    assert.equal(result.status, "SUCCESS");
    assert.equal(receiver.received.length, 1);

    const envelope = JSON.parse(receiver.received[0]!.body);
    assert.equal(envelope.type, "webhook.test");
  } finally {
    receiver.server.close();
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});

test("testWebhookEndpoint refuses to fire at a revoked endpoint", async () => {
  await seed();
  const owner = await createTestUser("webhook-test-revoked");
  const org = await createTestOrganization("webhook-test-revoked");

  try {
    const endpoint = await createWebhookEndpoint({
      organizationId: org.id,
      applicationKey: "NA_PISTA",
      url: "https://example.test/hook",
      eventTypes: ["order.created"],
      actorUserId: owner.id,
    });
    await revokeWebhookEndpoint({ organizationId: org.id, webhookId: endpoint.id, actorUserId: owner.id });

    await assert.rejects(() => testWebhookEndpoint({ organizationId: org.id, webhookId: endpoint.id }), ConflictError);
  } finally {
    await deleteTestOrganization(org.id);
    await deleteTestUser(owner.id);
  }
});
