import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, webhookEndpoints, webhookEventSubscriptions } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { encryptWebhookSecret, generateWebhookSecret } from "./crypto.js";
import { deliverWebhook } from "./delivery.js";

interface MetadataRow {
  id: string;
  organizationId: string;
  status: string;
  revokedAt: Date | null;
  createdAt: Date;
  applicationKey: string;
}

/** Never includes secretEncrypted or any cryptographic material — same posture as api_keys' shapeMetadata. */
function shapeMetadata(row: MetadataRow, eventTypes: string[]) {
  return {
    id: row.id,
    application: row.applicationKey,
    organizationId: row.organizationId,
    status: row.status,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    eventTypes,
  };
}

async function getSubscribedEventTypes(webhookEndpointId: string): Promise<string[]> {
  const rows = await db
    .select({ eventType: webhookEventSubscriptions.eventType })
    .from(webhookEventSubscriptions)
    .where(eq(webhookEventSubscriptions.webhookEndpointId, webhookEndpointId))
    .orderBy(webhookEventSubscriptions.eventType);
  return rows.map((r) => r.eventType);
}

async function getSubscribedEventTypesByEndpointId(endpointIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (endpointIds.length === 0) return map;

  const rows = await db
    .select({ webhookEndpointId: webhookEventSubscriptions.webhookEndpointId, eventType: webhookEventSubscriptions.eventType })
    .from(webhookEventSubscriptions)
    .where(inArray(webhookEventSubscriptions.webhookEndpointId, endpointIds));

  for (const row of rows) {
    const existing = map.get(row.webhookEndpointId);
    if (existing) existing.push(row.eventType);
    else map.set(row.webhookEndpointId, [row.eventType]);
  }
  return map;
}

export async function createWebhookEndpoint(input: {
  organizationId: string;
  applicationKey: string;
  url: string;
  eventTypes: string[];
  actorUserId: string;
}) {
  const [application] = await db
    .select({ id: applications.id, key: applications.key })
    .from(applications)
    .where(eq(applications.key, input.applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${input.applicationKey}`);

  const uniqueEventTypes = [...new Set(input.eventTypes)];
  const secret = generateWebhookSecret();
  const secretEncrypted = encryptWebhookSecret(secret);

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(webhookEndpoints)
      .values({
        applicationId: application.id,
        organizationId: input.organizationId,
        url: input.url,
        secretEncrypted,
        createdByUserId: input.actorUserId,
      })
      .returning();
    if (!created) throw new Error("Failed to create webhook endpoint");

    await tx
      .insert(webhookEventSubscriptions)
      .values(uniqueEventTypes.map((eventType) => ({ webhookEndpointId: created.id, eventType })));

    return created;
  });

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: application.id,
    action: "webhook.created",
    targetType: "webhook_endpoint",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey, url: input.url, eventTypes: uniqueEventTypes },
  });

  return {
    ...shapeMetadata({ ...row, applicationKey: application.key }, uniqueEventTypes),
    // shown exactly once — never persisted in plaintext, never re-derivable
    secret,
  };
}

export async function listWebhookEndpointsForOrganization(organizationId: string) {
  const rows = await db
    .select({
      id: webhookEndpoints.id,
      organizationId: webhookEndpoints.organizationId,
      status: webhookEndpoints.status,
      revokedAt: webhookEndpoints.revokedAt,
      createdAt: webhookEndpoints.createdAt,
      applicationKey: applications.key,
    })
    .from(webhookEndpoints)
    .innerJoin(applications, eq(applications.id, webhookEndpoints.applicationId))
    .where(eq(webhookEndpoints.organizationId, organizationId))
    .orderBy(webhookEndpoints.createdAt);

  const eventTypesByEndpointId = await getSubscribedEventTypesByEndpointId(rows.map((r) => r.id));
  return rows.map((row) => shapeMetadata(row, eventTypesByEndpointId.get(row.id) ?? []));
}

/** Tenant-safe by construction: organizationId is always part of the WHERE, never checked after the fact. */
export async function getWebhookEndpointDetail(organizationId: string, webhookId: string) {
  const [row] = await db
    .select({
      id: webhookEndpoints.id,
      organizationId: webhookEndpoints.organizationId,
      status: webhookEndpoints.status,
      revokedAt: webhookEndpoints.revokedAt,
      createdAt: webhookEndpoints.createdAt,
      applicationKey: applications.key,
    })
    .from(webhookEndpoints)
    .innerJoin(applications, eq(applications.id, webhookEndpoints.applicationId))
    .where(and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new NotFoundError("Webhook endpoint not found");
  return shapeMetadata(row, await getSubscribedEventTypes(row.id));
}

export async function revokeWebhookEndpoint(input: {
  organizationId: string;
  webhookId: string;
  actorUserId: string;
}) {
  const [current] = await db
    .select({ id: webhookEndpoints.id, status: webhookEndpoints.status, applicationId: webhookEndpoints.applicationId })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, input.webhookId), eq(webhookEndpoints.organizationId, input.organizationId)))
    .limit(1);
  if (!current) throw new NotFoundError("Webhook endpoint not found");
  if (current.status === "REVOKED") throw new ConflictError("Webhook endpoint is already revoked");

  const [updated] = await db
    .update(webhookEndpoints)
    .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, input.webhookId))
    .returning();
  if (!updated) throw new NotFoundError("Webhook endpoint not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: current.applicationId,
    action: "webhook.revoked",
    targetType: "webhook_endpoint",
    targetId: input.webhookId,
  });

  const [application] = await db
    .select({ key: applications.key })
    .from(applications)
    .where(eq(applications.id, current.applicationId));

  return shapeMetadata(
    { ...updated, applicationKey: application!.key },
    await getSubscribedEventTypes(updated.id),
  );
}

/**
 * Fires a synthetic `webhook.test` event at exactly this one endpoint,
 * bypassing its event-type subscriptions (an explicit test request is
 * itself the authorization to deliver, regardless of what the endpoint is
 * normally subscribed to). Reuses `deliverWebhook` — no separate delivery
 * path — so a passing test is a real signal that live delivery will work.
 */
export async function testWebhookEndpoint(input: { organizationId: string; webhookId: string }) {
  const [row] = await db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      secretEncrypted: webhookEndpoints.secretEncrypted,
      status: webhookEndpoints.status,
      applicationKey: applications.key,
    })
    .from(webhookEndpoints)
    .innerJoin(applications, eq(applications.id, webhookEndpoints.applicationId))
    .where(and(eq(webhookEndpoints.id, input.webhookId), eq(webhookEndpoints.organizationId, input.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Webhook endpoint not found");
  if (row.status !== "ACTIVE") throw new ConflictError("Webhook endpoint is revoked");

  return deliverWebhook({
    endpoint: { id: row.id, url: row.url, secretEncrypted: row.secretEncrypted },
    event: {
      id: `evt_${randomUUID()}`,
      type: "webhook.test",
      source: { application: row.applicationKey },
      organizationId: input.organizationId,
      occurredAt: new Date().toISOString(),
      data: {},
    },
  });
}
