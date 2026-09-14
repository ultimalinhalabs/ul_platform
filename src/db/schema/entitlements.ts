import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";
import { subscriptions } from "./subscriptions.js";

/**
 * Answers "what capability does this organization/application have?".
 * Usually derived from an active subscription's plan, but kept as its own
 * resolved record so manual grants/overrides don't require faking a plan.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    key: text("key").notNull(),
    value: jsonb("value"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("entitlements_org_app_key_unique").on(
      table.organizationId,
      table.applicationId,
      table.key,
    ),
  ],
);
