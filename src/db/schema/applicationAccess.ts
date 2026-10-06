import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Fase 6 — explicit Organization → Application access, deliberately
 * SEPARATE from commercial subscriptions (Organization → Subscription →
 * Plan → Entitlements). Identity/organization adoption must never require a
 * billing record; the commercial layer is Fase 7.
 *
 * Effective application access = an ACTIVE row here — nothing else. A
 * subscription never implies access and access never implies a
 * subscription (Na Pista keeps gating its features on entitlements, which
 * is the commercial layer). Revocation is a status change, never a delete
 * (auditability).
 */
export const organizationApplicationAccess = pgTable(
  "organization_application_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("organization_application_access_org_app_unique").on(table.organizationId, table.applicationId),
    check("organization_application_access_status_check", sql`${table.status} in ('active', 'revoked')`),
  ],
);
