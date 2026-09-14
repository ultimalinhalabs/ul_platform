import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { users } from "./users.js";

/**
 * Application-level information about a User (display name, avatar, ...).
 * Deliberately separate from `users`, which mirrors the auth identity.
 */
export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  locale: text("locale"),
  ...timestamps,
});
