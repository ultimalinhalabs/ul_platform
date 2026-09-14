import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * A registered product/consumer of the platform (e.g. NA_PISTA,
 * MICHA_EXPRESS, FOI, QUALE_A_DICA, UL_CONSOLE). This is a registry entry,
 * not a module — UL Platform never implements a product's business logic
 * under this table.
 */
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
});
