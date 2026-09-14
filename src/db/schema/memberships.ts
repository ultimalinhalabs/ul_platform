import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { organizations } from "./organizations.js";
import { roles } from "./roles.js";
import { users } from "./users.js";

/**
 * A User's business/staff relationship with an Organization.
 * NOT used to represent end-customers — see `customers`.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: text("status", { enum: ["active", "invited", "suspended"] })
      .notNull()
      .default("active"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("memberships_user_org_unique").on(table.userId, table.organizationId)],
);
