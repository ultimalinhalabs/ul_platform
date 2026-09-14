import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { roles } from "./roles.js";

/** Answers "what can this actor do?" — e.g. "organization.manage_members". */
export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description"),
  ...timestamps,
});

/** Join table: which permissions a role grants. */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);
