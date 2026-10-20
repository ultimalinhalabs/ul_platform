import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { organizations } from "./organizations.js";
import { plans } from "./plans.js";

export const SUBSCRIPTION_ORIGINS = ["commercial", "demo", "test", "legacy"] as const;

/**
 * The commercial relationship between an Organization and a Plan.
 * "Occupies a slot" (blocks a duplicate) means any status other than
 * `canceled` — trialing/active/past_due are all still a live relationship,
 * only `canceled` is history. The partial unique index below enforces
 * "at most one non-canceled subscription per (organization, plan)" at
 * the database level.
 *
 * That only covers the *same plan* twice — it can't by itself stop two
 * *different* plans of the *same application* being active
 * simultaneously (Application is reachable only via planId, so a single-
 * table index can't express that). That broader rule — at most one
 * active subscription per (organization, application) — is enforced
 * transactionally in the service layer instead (see
 * modules/subscriptions/service.ts), which is the schema-change-avoiding
 * option this was deliberately built to prefer.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: text("status", {
      enum: ["trialing", "active", "past_due", "canceled"],
    })
      .notNull()
      .default("active"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    /**
     * Migration 0031 — what kind of relationship this is, for migration and reporting decisions only (never read
     * by entitlement resolution). Contract activation writes `commercial`; rows created before 0031 stay NULL
     * until classified one by one with the owner's approval (scripts/classify-subscriptions.ts).
     */
    origin: text("origin", { enum: SUBSCRIPTION_ORIGINS }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subscriptions_org_plan_not_canceled_unique")
      .on(table.organizationId, table.planId)
      .where(sql`${table.status} <> 'canceled'`),
    check("subscriptions_origin_check", sql`${table.origin} is null or ${table.origin} in ('commercial', 'demo', 'test', 'legacy')`),
  ],
);
