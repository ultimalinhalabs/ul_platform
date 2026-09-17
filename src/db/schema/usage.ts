import { index, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";

/**
 * Global registry of measurable resources (e.g. "orders", "api_requests") —
 * the metering equivalent of `service_scopes`/`permissions`. Platform-
 * defined and seeded; there is no endpoint to register a new meter over
 * HTTP, for the same reason `service_scopes` has none (no PLATFORM_ADMIN
 * actor yet — see CLAUDE.md §11). `unit` is a free-form label the platform
 * never interprets or does arithmetic on ("count", "bytes", "requests", ...)
 * — the meter defines what its own quantity means; the platform only
 * records and sums it.
 */
export const meters = pgTable("meters", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  unit: text("unit").notNull(),
  description: text("description"),
  ...timestamps,
});

/**
 * Which Applications may record/query usage against a Meter — the
 * metering equivalent of `application_service_scopes`. A NA_PISTA
 * credential can never write to a MICHA_EXPRESS-only meter because that
 * pair simply has no row here (see modules/usage/service.ts). Deliberately
 * a separate join table from `application_service_scopes`: a Meter is a
 * measurement definition, a Scope is an authorization definition — they
 * answer different questions and are never coupled to each other.
 */
export const applicationMeters = pgTable(
  "application_meters",
  {
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.meterId] })],
);

/**
 * One immutable fact: "this much of this meter happened, at this time".
 * Append-only — there is no update endpoint and no code path that mutates
 * a row after insert (see README "Usage": a correction is a new event,
 * e.g. a negative-quantity adjustment, never an edit of history).
 *
 * `organizationId` is NOT NULL: v1's only usage-writing credential is an
 * organization-scoped API key (same reasoning as `webhook_endpoints` —
 * there is no platform-level/null-organization form creatable over HTTP
 * yet, so a nullable column here would be dead schema, not forward
 * compatibility). `applicationId`/`meterId` are `ON DELETE RESTRICT` (like
 * `api_keys.applicationId`/`plans.applicationId`) — historical usage must
 * outlive an application's or meter's lifecycle, never cascade-delete.
 *
 * `quantity` is `numeric(20, 6)`, never `integer`/`double precision`:
 * exact decimal storage avoids floating-point drift when aggregating many
 * rows, while still allowing fractional quantities (e.g. a fractional
 * byte-rate meter) a plain integer couldn't represent. 20 total digits /
 * 6 decimal places is a generous, bounded ceiling — comfortably covers
 * large counters and small fractional units — chosen over unbounded
 * `numeric` so a malformed value can't silently create an
 * unbounded-precision row. See README "Quantity & Units".
 *
 * No `period` column: any period (a day, a month, an arbitrary range) is
 * always derivable from `occurredAt` at query time
 * (`modules/usage/service.ts`) — persisting a redundant bucket string
 * would duplicate `occurredAt` and still couldn't represent an arbitrary
 * from/to range. See README "Periods".
 *
 * Idempotency is a real database constraint
 * (`usage_events_idempotency_unique`), not just application-code
 * discipline: submitting the same `idempotencyKey` twice for the same
 * (organization, application, meter) resolves to the original row
 * (`modules/usage/service.ts`'s `INSERT ... ON CONFLICT DO NOTHING` +
 * re-select), never a second counted event.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_events_idempotency_unique").on(
      table.organizationId,
      table.applicationId,
      table.meterId,
      table.idempotencyKey,
    ),
    // Matches the one real query shape (getUsage*: equality on org+app+meter,
    // range on occurredAt) — its leftmost prefixes also serve org-only and
    // org+app-only lookups, so no separate single-column indexes are added
    // (see README "Performance").
    index("usage_events_query_idx").on(
      table.organizationId,
      table.applicationId,
      table.meterId,
      table.occurredAt,
    ),
  ],
);
