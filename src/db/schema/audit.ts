import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Cross-cutting log of security-sensitive operations (membership changes,
 * permission changes, subscription changes, API key issuance/revocation,
 * ...). Intentionally NOT a catch-all event store — see CLAUDE.md §20.
 *
 * Indexes (Fase 16 §27) match `listPlatformAuditLogs`'s real query shape
 * (`modules/audit/service.ts`), not every column indiscriminately:
 *   - `(created_at desc, id desc)` — the keyset-pagination ORDER BY/WHERE,
 *     used on every call regardless of filters.
 *   - `action` — the control-plane prefix allowlist (`LIKE 'platform.%' OR
 *     ...`, btree-usable for a trailing-wildcard prefix) plus the optional
 *     exact-action filter; also the busiest column-only lookup.
 *   - `actor_user_id` — already a foreign key and a real filter param, so
 *     indexing it costs little and directly serves that filter.
 * `target_type`/`target_id` stay unindexed: always used alongside another
 * condition, never proven as a standalone bottleneck.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_created_at_id_idx").on(table.createdAt.desc(), table.id.desc()),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_actor_user_id_idx").on(table.actorUserId),
  ],
);
