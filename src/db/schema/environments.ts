import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";

/**
 * A deployment context for an Application (e.g. NA_PISTA's "production" vs
 * "staging") — platform-level infrastructure metadata, never organization-
 * owned (CLAUDE.md's discovery prompt §29: Application/Environment/
 * Endpoint/Integration are platform resources, not tenant resources).
 * `key` is unique only *within* its application (mirrors `plans.key`).
 * A local development environment is intentionally never registered here
 * — it exists only on a developer's machine; nothing platform-wide needs
 * to know about it (see README "Environments").
 *
 * `status` is a small explicit ACTIVE/INACTIVE lifecycle, not a state
 * machine (no DRAINING/MAINTENANCE/etc.): an INACTIVE environment simply
 * stops being a valid Service Discovery target. Its configuration — and
 * any endpoints under it — is never deleted when it goes inactive.
 */
export const applicationEnvironments = pgTable(
  "application_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    status: text("status", { enum: ["ACTIVE", "INACTIVE"] })
      .notNull()
      .default("ACTIVE"),
    ...timestamps,
  },
  (table) => [uniqueIndex("application_environments_application_key_unique").on(table.applicationId, table.key)],
);

/**
 * A network address an Application Environment exposes — the "where do I
 * connect" half of Service Discovery. Deliberately no separate `domains`
 * table alongside this one: a "domain" would only ever be the host portion
 * of `baseUrl`, derivable by parsing it, not an independent concept worth
 * its own row — see README "Domains" for the full reasoning. `type` is a
 * small closed enum (`API` only in v1 — see README "Endpoint Type"), not a
 * free-form string, so nothing can invent an endpoint type that means
 * nothing to anything.
 *
 * At most one endpoint per (environment, type): v1 has no concept of two
 * competing "the" API endpoints for one environment — an ambiguity the
 * unique index below prevents structurally, not by convention.
 */
export const applicationEndpoints = pgTable(
  "application_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => applicationEnvironments.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["API"] }).notNull(),
    baseUrl: text("base_url").notNull(),
    status: text("status", { enum: ["ACTIVE", "INACTIVE"] })
      .notNull()
      .default("ACTIVE"),
    ...timestamps,
  },
  (table) => [uniqueIndex("application_endpoints_environment_type_unique").on(table.environmentId, table.type)],
);
