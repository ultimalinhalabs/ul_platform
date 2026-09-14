import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * Global catalog of membership roles (e.g. "owner", "manager", "staff").
 * Roles are platform-defined for v1; per-organization custom roles are a
 * future extension, not something to build speculatively now.
 */
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
});
