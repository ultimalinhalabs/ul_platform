import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries, webhookEndpoints, webhookEventSubscriptions } from "../../db/schema/index.js";
import { decryptWebhookSecret } from "./crypto.js";
import { signWebhookPayload } from "./signature.js";

/**
 * The generic transport envelope (CLAUDE.md §18) — UL Platform governs this
 * shape; it never interprets `data`, which belongs entirely to the
 * originating product. `source.application` is always populated from a
 * trusted, already-authenticated identity (the publishing service
 * credential's own `applicationKey`) — never anything a request body
 * could override, see routes/v1/events.ts.
 */
export interface EventEnvelope {
  id: string;
  type: string;
  source: { application: string };
  organizationId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

interface DeliveryEndpoint {
  id: string;
  url: string;
  secretEncrypted: string;
}

/**
 * One HTTP POST, one delivery record — no retry loop (see README
 * "Retries": v1 makes exactly one attempt; `attempt` exists on the row so
 * a future retry mechanism can increment it without a schema change).
 * Never throws: a delivery failure (network error, non-2xx response) is
 * a recorded outcome, not an exception the caller must handle — matching
 * `recordAuditEvent`'s "never breaks the calling operation" posture.
 */
export async function deliverWebhook(input: {
  endpoint: DeliveryEndpoint;
  event: EventEnvelope;
}): Promise<{ status: "SUCCESS" | "FAILED"; responseStatus: number | null }> {
  const rawBody = JSON.stringify(input.event);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decryptWebhookSecret(input.endpoint.secretEncrypted);
  const signature = signWebhookPayload(secret, timestamp, rawBody);

  let status: "SUCCESS" | "FAILED" = "FAILED";
  let responseStatus: number | null = null;

  try {
    const response = await fetch(input.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ul-event-id": input.event.id,
        "x-ul-event-type": input.event.type,
        "x-ul-timestamp": String(timestamp),
        "x-ul-signature": signature,
      },
      body: rawBody,
    });
    responseStatus = response.status;
    status = response.ok ? "SUCCESS" : "FAILED";
  } catch {
    // network error / unreachable endpoint — responseStatus stays null
    status = "FAILED";
  }

  await db.insert(webhookDeliveries).values({
    webhookEndpointId: input.endpoint.id,
    eventId: input.event.id,
    eventType: input.event.type,
    status,
    responseStatus,
    deliveredAt: status === "SUCCESS" ? new Date() : null,
  });

  return { status, responseStatus };
}

/**
 * "Something happened" (CLAUDE.md §14): builds the event envelope from a
 * trusted publisher identity, finds every ACTIVE endpoint in this
 * organization subscribed to this event type, and delivers to each — never
 * to an endpoint that didn't explicitly subscribe (§20). Delivery is
 * fire-and-record: one endpoint's failure never blocks another's delivery.
 */
export async function publishEvent(input: {
  organizationId: string;
  sourceApplicationKey: string;
  type: string;
  data: Record<string, unknown>;
}): Promise<{ eventId: string; type: string; occurredAt: string; deliveries: number }> {
  const event: EventEnvelope = {
    id: `evt_${randomUUID()}`,
    type: input.type,
    source: { application: input.sourceApplicationKey },
    organizationId: input.organizationId,
    occurredAt: new Date().toISOString(),
    data: input.data,
  };

  const endpoints = await db
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, secretEncrypted: webhookEndpoints.secretEncrypted })
    .from(webhookEndpoints)
    .innerJoin(webhookEventSubscriptions, eq(webhookEventSubscriptions.webhookEndpointId, webhookEndpoints.id))
    .where(
      and(
        eq(webhookEndpoints.organizationId, input.organizationId),
        eq(webhookEndpoints.status, "ACTIVE"),
        eq(webhookEventSubscriptions.eventType, input.type),
      ),
    );

  await Promise.all(endpoints.map((endpoint) => deliverWebhook({ endpoint, event })));

  return { eventId: event.id, type: event.type, occurredAt: event.occurredAt, deliveries: endpoints.length };
}
