import { pgTable, text, uuid } from "drizzle-orm/pg-core";
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
  ...timestamps,
});
