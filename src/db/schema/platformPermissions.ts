import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { platformRoles } from "./platformRoles.js";

/**
 * Answers "what can this platform authority do?" — the control-plane
 * counterpart of `permissions` (which answers the same question for
 * Organization actors). Kept in its own table/namespace rather than added
 * as rows to `permissions`: an Organization ADMIN must never be able to
 * hold something that reads like `platform.application.manage` merely
 * because it lives in the same catalog they can already query via
 * `GET /v1/roles/:key`. Key convention is `platform.<resource>.<action>`
 * (e.g. `platform.application.manage`) so it's visually and namespace-wise
 * unambiguous from an organization permission key like `organization.update`.
 */
export const platformPermissions = pgTable("platform_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description"),
  ...timestamps,
});

/** Join table: which platform permissions a platform role grants. */
export const platformRolePermissions = pgTable(
  "platform_role_permissions",
  {
    platformRoleId: uuid("platform_role_id")
      .notNull()
      .references(() => platformRoles.id, { onDelete: "cascade" }),
    platformPermissionId: uuid("platform_permission_id")
      .notNull()
      .references(() => platformPermissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.platformRoleId, table.platformPermissionId] })],
);
