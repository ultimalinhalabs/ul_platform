import { sql } from "drizzle-orm";
import { check, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { users } from "./users.js";

/** A business tenant. Organizations do not imply any specific product. */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id),
  /**
   * Fase 6. `suspended` blocks normal operation: no membership-scoped route
   * and no organization-scoped service key works while suspended (see
   * requireOrganizationMembership / requireServiceOrganizationMatch).
   */
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  ...timestamps,
}, (table) => [check("organizations_status_check", sql`${table.status} in ('active', 'suspended')`)]);
