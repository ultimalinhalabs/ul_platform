import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * A registered product/consumer of the platform (e.g. NA_PISTA,
 * MICHA_EXPRESS, FOI, QUALE_A_DICA, UL_CONSOLE). This is a registry entry,
 * not a module — UL Platform never implements a product's business logic
 * under this table.
 *
 * `status` exists so an application can stop accepting new
 * subscriptions (SUSPENDED) or be retired (DEPRECATED) without a
 * physical delete — once Plans/Subscriptions reference an application,
 * `plans.applicationId` is ON DELETE RESTRICT anyway, so this is about
 * lifecycle *before* that FK protection would even apply (e.g. an
 * application with zero plans yet). No separate "REGISTERED" pre-active
 * state: nothing creates an application via an API yet that would need
 * a pending/unapproved phase, so it would be a state with no transition
 * into or out of it.
 */
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["ACTIVE", "SUSPENDED", "DEPRECATED"] })
    .notNull()
    .default("ACTIVE"),
  ...timestamps,
});
