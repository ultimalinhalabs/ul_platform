import { foreignKey, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { memberships } from "./memberships.js";

/**
 * Fase 6 — per-application role catalog. Each application declares the
 * roles IT understands (QUALE_A_DICA: OWNER/ADMIN/AGENT; NA_PISTA:
 * OWNER/ADMIN/MANAGER/STAFF). These are an additional layer on top of the
 * organization-wide `roles` — never a replacement: a membership keeps its
 * organization role, and may additionally carry an application role.
 * Roles are not permissions: what a role may DO inside an application is
 * that application's own domain authorization.
 */
export const applicationRoles = pgTable(
  "application_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps,
  },
  (table) => [unique("application_roles_application_key_unique").on(table.applicationId, table.key)],
);

/**
 * Fase 6 — an explicit role for one membership inside one application.
 * At most one per (membership, application). When absent, the effective
 * application role falls back to a documented mapping of the
 * organization role (see modules/applicationRoles/effectiveRole.ts).
 * The composite FK guarantees `role_key` exists in THAT application's
 * catalog — a QD role can never be attached to Na Pista.
 */
export const membershipApplicationRoles = pgTable(
  "membership_application_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("membership_application_roles_membership_application_unique").on(table.membershipId, table.applicationId),
    foreignKey({
      name: "membership_application_roles_role_fk",
      columns: [table.applicationId, table.roleKey],
      foreignColumns: [applicationRoles.applicationId, applicationRoles.key],
    }),
  ],
);
