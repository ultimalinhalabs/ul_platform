import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
 * Observability record for one delivery attempt — never the event payload
 * itself, never any secret. `attempt` starts at 1; v1 makes exactly one
 * attempt per event/endpoint (no retry worker — see README "Retries"), so
 * this column exists purely so a future retry mechanism can increment it
 * without a schema change, not because anything writes 2 today.
 *
 * No uniqueness constraint on (endpointId, eventId): v1's single-attempt
 * delivery means at most one row naturally exists per pair today, but a
 * future retry mechanism would need to insert additional attempt rows for
 * the same pair — a unique constraint here would have to be dropped again
 * later, so it's deliberately not added now (see README "Idempotency").
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
    status: text("status", { enum: ["SUCCESS", "FAILED"] }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    responseStatus: integer("response_status"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("webhook_deliveries_endpoint_id_idx").on(table.webhookEndpointId),
    index("webhook_deliveries_event_id_idx").on(table.eventId),
  ],
);
