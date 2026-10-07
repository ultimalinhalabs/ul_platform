import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { organizationApplicationAccess } from "./applicationAccess.js";
import { applications } from "./applications.js";
import { contractItems, contracts } from "./contracts.js";
import { organizations } from "./organizations.js";
import { plans } from "./plans.js";
import { subscriptions } from "./subscriptions.js";
import { users } from "./users.js";

export const ENTITLEMENT_GRANT_STATUSES = ["planned", "active", "expired", "revoked"] as const;

/**
 * Block 1A — the explicit layer between a contract and the existing
 * subscription/application-access records. A grant is `planned` when the
 * contract is created; only an explicit, audited activation (future service,
 * `platform.entitlement.grant`) turns it `active` and links the subscription
 * and application access it created. Accepting a proposal never writes to
 * `subscriptions` or `organization_application_access` directly.
 * One grant per contract item; at most one ACTIVE grant per
 * (organization, application) — matching the one-non-canceled-subscription-
 * per-application rule (activation refuses with 409, never replaces).
 * Grants are history: never deleted (trigger, migration 0019).
 */
export const entitlementGrants = pgTable(
  "entitlement_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    contractItemId: uuid("contract_item_id")
      .notNull()
      .references(() => contractItems.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "restrict" }),
    entitlementsSnapshot: jsonb("entitlements_snapshot").notNull().default(sql`'{}'::jsonb`),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: text("status", { enum: ENTITLEMENT_GRANT_STATUSES }).notNull().default("planned"),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "restrict" }),
    applicationAccessId: uuid("application_access_id").references(() => organizationApplicationAccess.id, { onDelete: "restrict" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: uuid("activated_by").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "restrict" }),
    revokeReason: text("revoke_reason"),
    ...timestamps,
  },
  (table) => [
    unique("entitlement_grants_contract_item_unique").on(table.contractItemId),
    uniqueIndex("entitlement_grants_one_active_per_app")
      .on(table.organizationId, table.applicationId)
      .where(sql`${table.status} = 'active'`),
    index("entitlement_grants_contract_idx").on(table.contractId),
    index("entitlement_grants_organization_idx").on(table.organizationId, table.status),
    check("entitlement_grants_status_check", sql`${table.status} in ('planned', 'active', 'expired', 'revoked')`),
    check("entitlement_grants_period_check", sql`${table.endsAt} is null or ${table.startsAt} is null or ${table.endsAt} > ${table.startsAt}`),
    check(
      "entitlement_grants_activation_check",
      sql`${table.status} = 'planned' or (${table.activatedAt} is not null and ${table.activatedBy} is not null) or ${table.status} = 'revoked'`,
    ),
    check("entitlement_grants_active_links_check", sql`${table.status} <> 'active' or ${table.subscriptionId} is not null`),
    check("entitlement_grants_revoked_check", sql`${table.status} <> 'revoked' or (${table.revokedAt} is not null and ${table.revokedBy} is not null)`),
  ],
);
