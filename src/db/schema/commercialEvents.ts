import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const COMMERCIAL_AGGREGATE_TYPES = [
  "terms_template",
  "proposal",
  "proposal_version",
  "proposal_access_link",
  "proposal_acceptance",
  "contract",
  "contract_version",
  "entitlement_grant",
] as const;

export const COMMERCIAL_ACTOR_TYPES = ["user", "platform_admin", "public_link", "system"] as const;

/**
 * Block 1A — the commercial domain's own history (proposal.sent,
 * proposal.viewed, proposal.accepted, contract.created, entitlement.activated,
 * …). It is business evidence, written in the SAME transaction as the change
 * it records (unlike `audit_logs`, which is a best-effort security log).
 * Append-only: a trigger refuses UPDATE/DELETE/TRUNCATE (migration 0016).
 * Never reuse `webhook_events` for this — those are outbound integration
 * events of an application, not the platform's commercial record.
 * Payloads carry identifiers and hashes, never secrets or link tokens.
 */
export const commercialEvents = pgTable(
  "commercial_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    aggregateType: text("aggregate_type", { enum: COMMERCIAL_AGGREGATE_TYPES }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    actorType: text("actor_type", { enum: COMMERCIAL_ACTOR_TYPES }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("commercial_events_aggregate_idx").on(table.aggregateType, table.aggregateId, table.occurredAt),
    index("commercial_events_event_type_idx").on(table.eventType, table.occurredAt),
    index("commercial_events_organization_idx").on(table.organizationId, table.occurredAt),
    uniqueIndex("commercial_events_idempotency_unique").on(table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    check(
      "commercial_events_aggregate_type_check",
      sql`${table.aggregateType} in ('terms_template', 'proposal', 'proposal_version', 'proposal_access_link', 'proposal_acceptance', 'contract', 'contract_version', 'entitlement_grant')`,
    ),
    check("commercial_events_actor_type_check", sql`${table.actorType} in ('user', 'platform_admin', 'public_link', 'system')`),
    check("commercial_events_event_type_check", sql`${table.eventType} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check("commercial_events_actor_user_check", sql`${table.actorType} not in ('user', 'platform_admin') or ${table.actorUserId} is not null`),
  ],
);
