import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { commercialTermsTemplates } from "./commercialTerms.js";

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
    /**
     * Migration 0024 — commercial catalog. `contractual` (default): sold only
     * through an assisted proposal. `self_service`: an organization OWNER may
     * contract it without a manual proposal (POST .../self-service/contracts),
     * at exactly these values — the server never takes a price from the client.
     * A self-service plan must carry price, currency, period (days) and the
     * terms template that applies; the terms must be APPROVED to contract.
     * Payment is ALWAYS required to activate (no flag can waive it). These
     * values are copied into the frozen proposal/contract at contracting time,
     * so changing them later never alters an accepted contract.
     * Not to be confused with SELF_SERVICE_PLANS (modules/subscriptions/
     * selfService.ts): that is a direct subscription WITHOUT a contract.
     */
    purchaseMode: text("purchase_mode", { enum: ["contractual", "self_service"] })
      .notNull()
      .default("contractual"),
    priceMinor: bigint("price_minor", { mode: "bigint" }),
    currency: text("currency"),
    periodDays: integer("period_days"),
    termsTemplateId: uuid("terms_template_id").references(() => commercialTermsTemplates.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("plans_application_key_unique").on(table.applicationId, table.key),
    check("plans_purchase_mode_check", sql`${table.purchaseMode} in ('contractual', 'self_service')`),
    check("plans_price_check", sql`${table.priceMinor} is null or ${table.priceMinor} >= 0`),
    check("plans_currency_check", sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`),
    check("plans_period_check", sql`${table.periodDays} is null or ${table.periodDays} between 1 and 3660`),
    check(
      "plans_self_service_terms_check",
      sql`${table.purchaseMode} <> 'self_service' or (${table.priceMinor} is not null and ${table.currency} is not null and ${table.periodDays} is not null and ${table.termsTemplateId} is not null)`,
    ),
  ],
);
