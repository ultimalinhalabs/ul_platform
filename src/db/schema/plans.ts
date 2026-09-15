import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";

/**
 * A commercial offer ("Business", "Starter") for one application. `key`
 * is only unique *within* its application (NA_PISTA and MICHA_EXPRESS
 * can each have their own "BUSINESS") — see the unique index below.
 *
 * `status` mirrors `applications.status`: ARCHIVED means "stop offering
 * this to new subscriptions" without a physical delete, which matters
 * once `subscriptions.planId` (ON DELETE RESTRICT) can reference a plan
 * — Postgres already refuses to delete a subscribed-to plan, so status
 * covers the lifecycle before that FK protection would apply.
 */
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] })
      .notNull()
      .default("ACTIVE"),
    ...timestamps,
  },
  (table) => [uniqueIndex("plans_application_key_unique").on(table.applicationId, table.key)],
);
