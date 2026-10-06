import { sql } from "drizzle-orm";
import { check, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * Platform-side mirror of a Supabase Auth identity.
 *
 * Supabase Auth (auth.users) is the source of truth for credentials. This
 * table shares its primary key with auth.users.id and is populated the
 * first time a verified JWT for that subject is seen. It exists so other
 * platform tables (memberships, customers, audit, ...) can have plain
 * foreign keys without reaching into the `auth` schema.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  /**
   * Fase 6. A `disabled` user is refused by `authenticate` even with a
   * valid Supabase session — the platform, not the IdP, decides whether an
   * identity may operate.
   */
  status: text("status", { enum: ["active", "disabled"] })
    .notNull()
    .default("active"),
  ...timestamps,
}, (table) => [check("users_status_check", sql`${table.status} in ('active', 'disabled')`)]);
