import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { entitlementGrants } from "./entitlementGrants.js";

export const ENTITLEMENT_VALUE_TYPES = ["boolean", "limit"] as const;
export const ENTITLEMENT_ABSENT_POLICIES = ["deny", "unlimited"] as const;
export const ENTITLEMENT_VALUE_SOURCES = ["plan", "addon", "override"] as const;

/**
 * Typed catalog of the entitlement keys each application understands (migration 0031, audit 2026-10-20).
 * Reverses the original "no catalog" choice (planEntitlements.ts) for one reason: an untyped key let a plan
 * carry a value no consumer reads (`advanced_reports.enabled`) or a value of the wrong type, and nothing
 * said which modules depend on which. The platform still knows no product semantics: a definition is only
 * (application, key, type, dependencies, absent policy) — the product applies it to its own operations.
 *
 *  - `key` is unique per application, never global: two applications can both define `members.max`.
 *  - `requires`: keys of the SAME application that must be enabled (true) in the same plan.
 *  - `absentPolicy` (limits only): what a consumer must do when a plan omits the key. `deny` is the default;
 *    `unlimited` must be declared explicitly per definition (addendum §3: absent never silently means unlimited).
 */
export const entitlementDefinitions = pgTable(
  "entitlement_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    valueType: text("value_type", { enum: ENTITLEMENT_VALUE_TYPES }).notNull(),
    module: text("module"),
    requires: text("requires").array().notNull().default(sql`'{}'::text[]`),
    absentPolicy: text("absent_policy", { enum: ENTITLEMENT_ABSENT_POLICIES }).notNull().default("deny"),
    status: text("status", { enum: ["active", "deprecated"] }).notNull().default("active"),
    description: text("description").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("entitlement_definitions_app_key_unique").on(table.applicationId, table.key),
    check("entitlement_definitions_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
    check("entitlement_definitions_value_type_check", sql`${table.valueType} in ('boolean', 'limit')`),
    check("entitlement_definitions_absent_policy_check", sql`${table.absentPolicy} in ('deny', 'unlimited') and (${table.valueType} = 'limit' or ${table.absentPolicy} = 'deny')`),
    check("entitlement_definitions_status_check", sql`${table.status} in ('active', 'deprecated')`),
  ],
);

/**
 * The entitlement values frozen for one contractual grant at activation (migration 0031). A plan edit never
 * changes what an accepted contract grants: resolution prefers these rows over `plan_entitlements` whenever
 * the granting subscription is backed by a grant. Insert-only (trigger): a value is never updated or
 * deleted; a different value means a new contract/grant. Rows may be inserted while the grant is `planned`
 * (activation) or `active` (one-off backfill of grants activated before 0031).
 */
export const grantEntitlementValues = pgTable(
  "grant_entitlement_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => entitlementGrants.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: text("source", { enum: ENTITLEMENT_VALUE_SOURCES }).notNull().default("plan"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("grant_entitlement_values_grant_key_unique").on(table.grantId, table.key),
    check("grant_entitlement_values_source_check", sql`${table.source} in ('plan', 'addon', 'override')`),
  ],
);

/**
 * Append-only history of every change to `plan_entitlements`, written by a database trigger so no path
 * (seed, loader script, manual SQL) can change a plan's commercial values silently (migration 0031).
 * `actor` = the `ul.actor` setting of the writing transaction when a script sets it, else the database role.
 * No FK to plans: history outlives a deleted plan.
 */
export const planEntitlementHistory = pgTable(
  "plan_entitlement_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull(),
    key: text("key").notNull(),
    operation: text("operation", { enum: ["insert", "update", "delete"] }).notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    actor: text("actor").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("plan_entitlement_history_plan_idx").on(table.planId, table.changedAt),
    check("plan_entitlement_history_operation_check", sql`${table.operation} in ('insert', 'update', 'delete')`),
  ],
);
