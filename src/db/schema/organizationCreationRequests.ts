import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Idempotency record of `POST /v1/organizations`. The caller's
 * `Idempotency-Key` is unique per user, so a retried request (double click,
 * network retry) resolves to the organization it already created — never a
 * second tenant. `request_sha256` is the canonical hash of the request body:
 * the same key with a different body is a 409, never a silent overwrite.
 *
 * Removed with its organization (CASCADE): once the tenant is deleted the
 * key no longer resolves to anything and may be used again.
 *
 * Organizations created through proposal acceptance (Block 1C) are covered
 * by the acceptance's own Idempotency-Key, not by this table.
 */
export const organizationCreationRequests = pgTable(
  "organization_creation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_creation_requests_key_unique").on(table.userId, table.idempotencyKey),
    check("organization_creation_requests_key_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  ],
);
