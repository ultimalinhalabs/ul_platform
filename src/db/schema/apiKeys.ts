import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * A machine credential for service-to-service authentication — never a
 * human session, never a membership. `id` doubles as the credential's
 * public key identifier (presented in the token as `ulk_<id>.<secret>`):
 * it is safe to expose (used to look the row up in O(1) via the primary
 * key index — see modules/apiKeys/service.ts) precisely because it is
 * not the secret. Only `secretHash` is ever persisted; the raw secret is
 * shown exactly once, at creation.
 *
 * `organizationId` is nullable by explicit design, not oversight:
 *   - non-null = an Organization's own integration with `applicationId`
 *     (e.g. "Organization ABC's NA_PISTA integration"). This is the only
 *     form the API can create in v1 (see README — no PLATFORM_ADMIN
 *     actor exists yet to safely authorize the null form over HTTP).
 *   - null = a platform/product-level service identity (e.g. "the
 *     NA_PISTA backend itself"), schema-ready for a controlled future
 *     provisioning path, but not creatable through this API today.
 *
 * `status` is a small explicit lifecycle (ACTIVE/REVOKED) rather than a
 * state machine — expiration is derived from `expiresAt <= now()` at
 * verification time, not a third persisted status, so nothing needs to
 * be mutated in the background when a key's time runs out.
 *
 * No `scopes` column: v1's only scope dimension is "which application,
 * which organization" (both already columns here). A fine-grained
 * action-level scope array would be unenforced ceremony until there is
 * an actual machine-consumable business endpoint to gate with it — see
 * README "API Keys" for what a service credential can access today.
 *
 * No `lastUsedAt`: tracking it would mean a database write on every
 * authenticated request, which needs an async/queued path this platform
 * deliberately doesn't have yet (see CLAUDE.md — no Redis, no queues).
 * Omitted rather than added-but-unmaintained.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretHash: text("secret_hash").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    status: text("status", { enum: ["ACTIVE", "REVOKED"] })
      .notNull()
      .default("ACTIVE"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [index("api_keys_organization_id_idx").on(table.organizationId)],
);
