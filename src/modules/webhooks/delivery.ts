import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookDeliveries, webhookEndpoints, webhookEvents, webhookEventSubscriptions } from "../../db/schema/index.js";
import { logger } from "../../shared/logger.js";
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
 * Fase 5 — retry policy (README "Webhooks: retries"). One delivery per
 * (endpoint, event); every attempt reuses the same `X-UL-Event-Id` and
 * `X-UL-Delivery-Id`.
 *
 *  - 2xx → SUCCESS.
 *  - 408, 425, 429, 5xx, network error, timeout → retry with exponential
 *    backoff + jitter (`Retry-After` honoured for 429/503, capped).
 *  - 3xx → FAILED (redirects are NOT followed: a signed payload must never be
 *    forwarded to a host the subscriber didn't register).
 *  - any other 4xx → FAILED (the receiver rejected it; repeating won't help).
 *  - attempts exhausted → EXHAUSTED.
 *
 * 8 attempts, 30 s base, ×2, cap 30 min → ≈ 30s, 1m, 2m, 4m, 8m, 16m, 30m
 * (~1 h of coverage), ±20 % jitter so a recovering receiver isn't hit by a
 * synchronized wave.
 */
export const WEBHOOK_RETRY_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 30 * 60_000,
  jitterRatio: 0.2,
  timeoutMs: 10_000,
  /** A claimed delivery is reclaimable after this — must exceed `timeoutMs` comfortably. */
  leaseMs: 60_000,
} as const;

export type AttemptOutcome = "SUCCESS" | "RETRY" | "PERMANENT";

export function classifyAttempt(responseStatus: number | null): AttemptOutcome {
  if (responseStatus == null) return "RETRY"; // network error / timeout
  if (responseStatus >= 200 && responseStatus < 300) return "SUCCESS";
  if (responseStatus === 408 || responseStatus === 425 || responseStatus === 429 || responseStatus >= 500) return "RETRY";
  return "PERMANENT"; // 1xx/3xx/other 4xx
}

/** Delay before attempt `attemptsMade + 1`. Pure; `random` injectable for tests. */
export function computeRetryDelayMs(attemptsMade: number, opts: { retryAfterSeconds?: number | null; random?: () => number } = {}): number {
  const p = WEBHOOK_RETRY_POLICY;
  if (opts.retryAfterSeconds != null && Number.isFinite(opts.retryAfterSeconds) && opts.retryAfterSeconds >= 0) {
    return Math.min(opts.retryAfterSeconds * 1000, p.maxDelayMs);
  }
  const exp = Math.min(p.baseDelayMs * 2 ** Math.max(attemptsMade - 1, 0), p.maxDelayMs);
  const jitter = (((opts.random ?? Math.random)() * 2 - 1) * p.jitterRatio) * exp;
  return Math.max(1000, Math.round(exp + jitter));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}

/**
 * One signed HTTP POST. Never throws. A fresh timestamp/signature per attempt
 * (the receiver's anti-replay window applies to each attempt), the SAME
 * event id and delivery id across attempts (the receiver's dedupe key).
 */
async function sendAttempt(input: {
  endpoint: DeliveryEndpoint;
  event: EventEnvelope;
  deliveryId: string | null;
  attempt: number;
}): Promise<{ responseStatus: number | null; retryAfterSeconds: number | null; latencyMs: number; error: string | null }> {
  const rawBody = JSON.stringify(input.event);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decryptWebhookSecret(input.endpoint.secretEncrypted);
  const signature = signWebhookPayload(secret, timestamp, rawBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_RETRY_POLICY.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(input.endpoint.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-ul-event-id": input.event.id,
        "x-ul-event-type": input.event.type,
        "x-ul-timestamp": String(timestamp),
        "x-ul-signature": signature,
        ...(input.deliveryId ? { "x-ul-delivery-id": input.deliveryId } : {}),
        "x-ul-delivery-attempt": String(input.attempt),
      },
      body: rawBody,
    });
    // Drain so the socket is released; the body itself is never stored.
    await response.arrayBuffer().catch(() => undefined);
    return {
      responseStatus: response.status,
      retryAfterSeconds: response.status === 429 || response.status === 503 ? parseRetryAfter(response.headers.get("retry-after")) : null,
      latencyMs: Date.now() - startedAt,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      responseStatus: null,
      retryAfterSeconds: null,
      latencyMs: Date.now() - startedAt,
      error: timedOut ? `timeout after ${WEBHOOK_RETRY_POLICY.timeoutMs}ms` : `network error: ${err instanceof Error ? err.name : "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single-attempt delivery — kept for `testWebhookEndpoint` (an explicit test
 * ping is not retried) and as the primitive the retry engine builds on.
 * Records exactly one SUCCESS/FAILED delivery row. Never throws.
 */
export async function deliverWebhook(input: {
  endpoint: DeliveryEndpoint;
  event: EventEnvelope;
}): Promise<{ status: "SUCCESS" | "FAILED"; responseStatus: number | null }> {
  const result = await sendAttempt({ endpoint: input.endpoint, event: input.event, deliveryId: null, attempt: 1 });
  const status = classifyAttempt(result.responseStatus) === "SUCCESS" ? "SUCCESS" : "FAILED";

  await db.insert(webhookDeliveries).values({
    webhookEndpointId: input.endpoint.id,
    eventId: input.event.id,
    eventType: input.event.type,
    status,
    attempt: 1,
    responseStatus: result.responseStatus,
    deliveredAt: status === "SUCCESS" ? new Date() : null,
    lastAttemptAt: new Date(),
    lastError: result.error,
    latencyMs: result.latencyMs,
  });

  return { status, responseStatus: result.responseStatus };
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/**
 * Atomically claims due PENDING deliveries (optionally one specific id):
 * `FOR UPDATE SKIP LOCKED` + a lease, so two workers/instances never attempt
 * the same delivery at the same time, and a crashed worker's claim expires.
 */
export async function claimDueDeliveries(
  workerId: string,
  opts: { deliveryId?: string; limit: number },
  executor: Pick<typeof db, "execute" | "select"> = db,
): Promise<DeliveryRow[]> {
  const leaseMs = WEBHOOK_RETRY_POLICY.leaseMs;
  const rows = await executor.execute(sql`
    UPDATE webhook_deliveries
       SET locked_until = now() + (${leaseMs}::int * interval '1 millisecond'), locked_by = ${workerId}
     WHERE id IN (
       SELECT id FROM webhook_deliveries
        WHERE status = 'PENDING'
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
          ${opts.deliveryId ? sql`AND id = ${opts.deliveryId}` : sql``}
        ORDER BY next_attempt_at
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id`);
  const ids = (rows as unknown as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return [];
  return executor.select().from(webhookDeliveries).where(inArray(webhookDeliveries.id, ids));
}

/** Makes one attempt for a claimed delivery and records the outcome — only if this worker still holds the lease. */
async function attemptClaimed(row: DeliveryRow, workerId: string): Promise<DeliveryRow["status"]> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id, url: webhookEndpoints.url, secretEncrypted: webhookEndpoints.secretEncrypted, status: webhookEndpoints.status })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, row.webhookEndpointId))
    .limit(1);
  const [event] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, row.eventId)).limit(1);
  const holdsLease = and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.lockedBy, workerId));

  if (!endpoint || endpoint.status !== "ACTIVE" || !event) {
    const reason = !event ? "event payload not found" : "endpoint revoked";
    await db
      .update(webhookDeliveries)
      .set({ status: "FAILED", lastError: reason, nextAttemptAt: null, lockedUntil: null, lockedBy: null })
      .where(holdsLease);
    logger.warn("webhook delivery abandoned", { module: "webhooks", event: "webhook.delivery.failed", deliveryId: row.id, eventId: row.eventId, endpointId: row.webhookEndpointId, reason });
    return "FAILED";
  }

  const attempt = row.attempt + 1;
  const envelope: EventEnvelope = {
    id: event.id,
    type: event.eventType,
    source: { application: event.sourceApplicationKey },
    organizationId: event.organizationId,
    occurredAt: event.occurredAt.toISOString(),
    data: event.payload,
  };
  const result = await sendAttempt({ endpoint, event: envelope, deliveryId: row.id, attempt });
  const outcome = classifyAttempt(result.responseStatus);
  const exhausted = outcome === "RETRY" && attempt >= WEBHOOK_RETRY_POLICY.maxAttempts;
  const status: DeliveryRow["status"] = outcome === "SUCCESS" ? "SUCCESS" : outcome === "PERMANENT" ? "FAILED" : exhausted ? "EXHAUSTED" : "PENDING";
  const nextAttemptAt =
    status === "PENDING" ? new Date(Date.now() + computeRetryDelayMs(attempt, { retryAfterSeconds: result.retryAfterSeconds })) : null;

  await db
    .update(webhookDeliveries)
    .set({
      status,
      attempt,
      responseStatus: result.responseStatus,
      deliveredAt: status === "SUCCESS" ? new Date() : null,
      nextAttemptAt,
      lastAttemptAt: new Date(),
      lastError: result.error,
      latencyMs: result.latencyMs,
      lockedUntil: null,
      lockedBy: null,
    })
    .where(holdsLease);

  logger.info("webhook delivery attempt", {
    module: "webhooks",
    event: "webhook.delivery.attempt",
    eventId: row.eventId,
    deliveryId: row.id,
    endpointId: row.webhookEndpointId,
    attempt,
    status,
    httpStatus: result.responseStatus,
    durationMs: result.latencyMs,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    final: status !== "PENDING",
  });
  return status;
}

/**
 * Retry engine — claims every due delivery (up to `limit`) and attempts each
 * once. Safe to run concurrently in several processes. All state is in
 * PostgreSQL, so a restart/deploy loses nothing: due rows are simply picked
 * up by the next run.
 */
export async function processDueWebhookDeliveries(opts: { limit?: number; workerId?: string } = {}): Promise<{ attempted: number }> {
  const workerId = opts.workerId ?? `webhook-worker-${randomUUID()}`;
  const claimed = await claimDueDeliveries(workerId, { limit: opts.limit ?? 50 });
  for (const row of claimed) await attemptClaimed(row, workerId);
  return { attempted: claimed.length };
}

/**
 * Poller run by the dedicated worker process (`worker.ts`; never by tests or
 * by the HTTP app). Fase 5.2: the timer is what keeps that process alive, so
 * it is not unref'd. Overlapping ticks are skipped; `stop()` resolves once an
 * in-flight tick has finished (an interrupted tick is still safe — its lease
 * simply expires and another worker picks the rows up).
 */
export function startWebhookRetryWorker(intervalMs = 15_000): { workerId: string; stop: () => Promise<void> } {
  const workerId = `webhook-worker-${randomUUID()}`;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = processDueWebhookDeliveries({ workerId })
      .then(() => undefined)
      .catch((err) => logger.error("webhook retry tick failed", { module: "webhooks", event: "webhook.worker.error", workerId, errorCode: err instanceof Error ? err.name : "unknown" }))
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  return {
    workerId,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}

/**
 * "Something happened" (CLAUDE.md §14). Fase 5:
 *  1. persists the event (stable `evt_` id) and one PENDING delivery per
 *     ACTIVE subscribed endpoint, in ONE transaction;
 *  2. with an `idempotencyKey`, a repeated publish returns the ORIGINAL event
 *     (`idempotent: true`) and creates no new deliveries;
 *  3. makes the first attempt inline (same response shape as before);
 *     failures are retried by `processDueWebhookDeliveries`.
 */
export async function publishEvent(input: {
  organizationId: string;
  sourceApplicationKey: string;
  type: string;
  data: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<{ eventId: string; type: string; occurredAt: string; deliveries: number; idempotent: boolean }> {
  const created = await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(webhookEvents)
      .values({
        id: `evt_${randomUUID()}`,
        organizationId: input.organizationId,
        sourceApplicationKey: input.sourceApplicationKey,
        eventType: input.type,
        payload: input.data,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (!event) return null;

    const endpoints = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .innerJoin(webhookEventSubscriptions, eq(webhookEventSubscriptions.webhookEndpointId, webhookEndpoints.id))
      .where(
        and(
          eq(webhookEndpoints.organizationId, input.organizationId),
          eq(webhookEndpoints.status, "ACTIVE"),
          eq(webhookEventSubscriptions.eventType, input.type),
        ),
      );
    const deliveries = endpoints.length
      ? await tx
          .insert(webhookDeliveries)
          .values(endpoints.map((e) => ({ webhookEndpointId: e.id, eventId: event.id, eventType: event.eventType, status: "PENDING" as const, attempt: 0, nextAttemptAt: new Date() })))
          .returning({ id: webhookDeliveries.id })
      : [];
    return { event, deliveryIds: deliveries.map((d) => d.id) };
  });

  if (!created) {
    // Same (organization, source, idempotencyKey) → the original event; nothing new is delivered.
    const [existing] = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.organizationId, input.organizationId),
          eq(webhookEvents.sourceApplicationKey, input.sourceApplicationKey),
          eq(webhookEvents.idempotencyKey, input.idempotencyKey!),
        ),
      )
      .limit(1);
    const deliveries = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.eventId, existing!.id));
    return { eventId: existing!.id, type: existing!.eventType, occurredAt: existing!.occurredAt.toISOString(), deliveries: deliveries.length, idempotent: true };
  }

  const workerId = `webhook-publish-${randomUUID()}`;
  await Promise.all(
    created.deliveryIds.map(async (deliveryId) => {
      const [row] = await claimDueDeliveries(workerId, { deliveryId, limit: 1 });
      if (row) await attemptClaimed(row, workerId);
    }),
  );

  return {
    eventId: created.event.id,
    type: created.event.eventType,
    occurredAt: created.event.occurredAt.toISOString(),
    deliveries: created.deliveryIds.length,
    idempotent: false,
  };
}
