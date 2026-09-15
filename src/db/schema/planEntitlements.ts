import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { plans } from "./plans.js";

/**
 * A capability or limit a Plan grants (e.g. `products.max` = 500,
 * `advanced_reports.enabled` = true). This is the Plan's *definition* of
 * what it offers — NOT the same table as `entitlements` (which resolves
 * what a specific Organization actually has, via a Subscription; not
 * built yet). Do not confuse the two.
 *
 * Deliberately no separate "entitlement catalog" table: unlike
 * `permissions`, entitlement keys are not a fixed platform vocabulary —
 * products define their own capability keys (see CLAUDE.md §10-11), so a
 * global definitions table would either be empty ceremony or would tempt
 * the platform into knowing product-specific semantics it must not know.
 * Cross-application leakage (a NA_PISTA plan accidentally carrying a
 * micha_express.* key) is prevented structurally, not by convention: a
 * row here belongs to exactly one `planId`, and a plan belongs to
 * exactly one application — there is no shared table two different
 * applications' plans could cross-reference.
 *
 * `value` is jsonb (same choice already made for `entitlements.value`)
 * so booleans, numbers and short strings are all representable without
 * a separate type/value-column pair.
 */
export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("plan_entitlements_plan_key_unique").on(table.planId, table.key)],
);
