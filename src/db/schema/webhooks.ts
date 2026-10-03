import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * A destination URL that receives event notifications for one Organization's
 * use of one Application (e.g. "Organization ABC's NA_PISTA endpoint") —
 * same ownership shape as `api_keys` (application-scoped, organization-
 * scoped in v1; a platform-level/null organizationId is not created through
 * this API today, for the identical reason documented on `api_keys`: no
 * PLATFORM_ADMIN actor to safely authorize it).
 *
 * `secretEncrypted` is reversible (AES-256-GCM), NOT a one-way hash like
 * `api_keys.secretHash` — deliberately different from the API-key strategy.
 * An API key only ever needs to be *verified* (does the presented secret
 * match?), so a one-way hash is strictly sufficient. A webhook secret must
 * also be *retrieved* later, because the platform itself is the one
 * producing the HMAC signature on outbound delivery — a hash can't be
 * reversed to do that. See modules/webhooks/crypto.ts for the encryption
 * scheme and README "Webhooks" for why this isn't reused API-key logic.
 * The raw secret is still shown exactly once, at creation, like an API key.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    status: text("status", { enum: ["ACTIVE", "REVOKED"] })
      .notNull()
      .default("ACTIVE"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("webhook_endpoints_organization_id_idx").on(table.organizationId)],
);

/**
 * Explicit event-type subscriptions for one endpoint — an endpoint receives
 * only the event types it lists here, never "everything" (see
 * CLAUDE.md/README "Webhook Subscriptions"). `eventType` is a validated
 * free-form string (`domain.action` convention), not a foreign key into a
 * global event-type catalog: v1 deliberately has no such catalog table
 * (see README "Event Types" — products own their own event vocabulary).
 */
export const webhookEventSubscriptions = pgTable(
  "webhook_event_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookEndpointId: uuid("webhook_endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("webhook_event_subscriptions_endpoint_type_unique").on(
      table.webhookEndpointId,
      table.eventType,
    ),
  ],
);

/**
 * Fase 5 — one published event, persisted so that delivery can be retried
 * after a restart/deploy (the envelope must exist somewhere other than the
 * publishing request's memory). `id` is the public `evt_<uuid>` sent as
 * `X-UL-Event-Id` on EVERY attempt to EVERY endpoint — stable identity is
 * what lets receivers deduplicate.
 *
 * `idempotencyKey` (optional, chosen by the publisher — e.g. its own fact
 * id): the same (organization, source application, key) always resolves to
 * the SAME event, so a publisher retrying its own call never creates a
 * second event. Same real-constraint pattern as `usage_events`.
 * `payload` is the product's `data` — UL Platform never interprets it.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceApplicationKey: text("source_application_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_events_idempotency_unique").on(table.organizationId, table.sourceApplicationKey, table.idempotencyKey),
    index("webhook_events_organization_id_idx").on(table.organizationId),
  ],
);

/**
 * Fase 5 — ONE row per (endpoint, event): the delivery, not an attempt. Every
 * retry updates this same row (`attempt` = attempts made so far), so the
 * delivery id is stable and `(webhook_endpoint_id, event_id)` is unique.
 *
 * States: PENDING (waiting for its next attempt at `next_attempt_at`) →
 * SUCCESS (2xx) | FAILED (permanent: non-retryable response, revoked
 * endpoint) | EXHAUSTED (retryable failures until the attempt limit).
 * Rows written before Fase 5 are SUCCESS/FAILED with `attempt = 1`.
 *
 * Concurrency: a worker claims a due row with `FOR UPDATE SKIP LOCKED` and a
 * lease (`locked_until`/`locked_by`); a crashed worker's lease simply expires
 * and another worker picks the row up — at-least-once, never in memory.
 * Never stores the payload (that's `webhook_events`) nor any secret.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookEndpointId: uuid("webhook_endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status", { enum: ["PENDING", "SUCCESS", "FAILED", "EXHAUSTED"] }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    responseStatus: integer("response_status"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("webhook_deliveries_endpoint_id_idx").on(table.webhookEndpointId),
    index("webhook_deliveries_event_id_idx").on(table.eventId),
    uniqueIndex("webhook_deliveries_endpoint_event_unique").on(table.webhookEndpointId, table.eventId),
    index("webhook_deliveries_due_idx").on(table.status, table.nextAttemptAt),
  ],
);
