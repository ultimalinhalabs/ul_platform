import { pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * An end-customer relationship between a User and an Organization.
 * Deliberately NOT a Membership: a customer has no administrative access
 * and does not gain access to the organization's dashboard.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("customers_user_org_unique").on(table.userId, table.organizationId)],
);
