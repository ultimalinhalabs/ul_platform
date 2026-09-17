import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { apiKeys } from "./apiKeys.js";
import { applications } from "./applications.js";

/**
 * Global registry of machine-actionable capabilities (e.g. `catalog.read`,
 * `payment.create`) — the service-identity equivalent of `permissions`.
 * Platform-defined and seeded, exactly like `permissions`/`roles`: there is
 * no PLATFORM_ADMIN actor yet to safely expose registry mutation over HTTP
 * (see CLAUDE.md §11), so this is a controlled seed, not a public catalog
 * an organization can add to. A caller can never grant itself a scope by
 * simply typing a new string — every requested scope at API-key creation
 * time is checked against this table (see modules/serviceScopes/service.ts).
 */
export const serviceScopes = pgTable("service_scopes", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description"),
  ...timestamps,
});

/**
 * Which scopes an Application is allowed to have its credentials request —
 * the capability set that bounds "compatible with that application" from
 * CLAUDE.md's service-scope prompt. Mirrors `role_permissions`'s join-table
 * shape. A credential belonging to QUALE_A_DICA can never be granted a
 * MICHA_EXPRESS-only scope, because that pair simply has no row here.
 */
export const applicationServiceScopes = pgTable(
  "application_service_scopes",
  {
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    serviceScopeId: uuid("service_scope_id")
      .notNull()
      .references(() => serviceScopes.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.serviceScopeId] })],
);

/**
 * The scopes actually granted to one API key at creation time — persisted
 * so authorization never re-evaluates "what was requested", only "what was
 * granted". Never mutated after creation in v1 (no scope-editing endpoint);
 * rotating scopes means issuing a new key, same operational pattern already
 * documented for secret rotation in README "API Keys".
 */
export const apiKeyScopes = pgTable(
  "api_key_scopes",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    serviceScopeId: uuid("service_scope_id")
      .notNull()
      .references(() => serviceScopes.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.serviceScopeId] })],
);
