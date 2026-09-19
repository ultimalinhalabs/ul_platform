import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * Platform-authority role catalog — deliberately a separate table from
 * `roles` (organization roles). Mixing the two would let an Organization's
 * RBAC and the Platform's control-plane RBAC collide in one namespace,
 * exactly what CLAUDE.md's Phase 13 brief warns against: "PLATFORM_ADMIN"
 * must never become a row an Organization's `role.assign` could ever touch.
 * Modeled as its own catalog (rather than a hardcoded string) so a future
 * second platform-authority tier doesn't need a schema change — v1 only
 * ever seeds `PLATFORM_ADMIN`.
 */
export const platformRoles = pgTable("platform_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
});
