import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
 *     NA_PISTA backend itself"), created only by a PLATFORM_ADMIN through
 *     `POST /v1/platform/credentials` (`platform.credential.manage`).
 *   Since D2-B, `credentialClass` (below) is the authority on what a key is.
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
export const CREDENTIAL_CLASSES = ["ORGANIZATION", "INTEGRATION_MANAGED", "PLATFORM_SERVICE"] as const;
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

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
    // D2-B — PENDING exists only for INTEGRATION_MANAGED credentials: issued, possession not yet proven.
    status: text("status", { enum: ["PENDING", "ACTIVE", "REVOKED"] })
      .notNull()
      .default("ACTIVE"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * D2-B — the structural, immutable class of the credential (the authority; never inferred from
     * `organizationId` after migration 0020):
     *  - ORGANIZATION: an organization's own integration key, created by its OWNER;
     *  - INTEGRATION_MANAGED: minted by the platform for one Organization × Application × purpose,
     *    bound to the provisioning request that issued it; never created, listed or revoked through
     *    the generic API key routes;
     *  - PLATFORM_SERVICE: a product-level identity (no organization); `purpose = PROVISIONER` is the
     *    reconciler credential that may only operate on provisioning requests.
     */
    credentialClass: text("credential_class", { enum: CREDENTIAL_CLASSES }).notNull(),
    purpose: text("purpose"),
    /** FK to credential_provisioning_requests (declared in migration 0020 — a schema-level reference would be circular). */
    provisioningRequestId: uuid("provisioning_request_id"),
    ...timestamps,
  },
  (table) => [
    index("api_keys_organization_id_idx").on(table.organizationId),
    index("api_keys_provisioning_request_id_idx").on(table.provisioningRequestId),
    check("api_keys_status_check", sql`${table.status} in ('PENDING', 'ACTIVE', 'REVOKED')`),
    check("api_keys_credential_class_check", sql`${table.credentialClass} in ('ORGANIZATION', 'INTEGRATION_MANAGED', 'PLATFORM_SERVICE')`),
    check(
      "api_keys_credential_class_shape_check",
      sql`(${table.credentialClass} = 'ORGANIZATION' and ${table.organizationId} is not null and ${table.purpose} is null and ${table.provisioningRequestId} is null)
       or (${table.credentialClass} = 'INTEGRATION_MANAGED' and ${table.organizationId} is not null and ${table.purpose} = 'platform_integration' and ${table.provisioningRequestId} is not null)
       or (${table.credentialClass} = 'PLATFORM_SERVICE' and ${table.organizationId} is null and (${table.purpose} is null or ${table.purpose} = 'PROVISIONER') and ${table.provisioningRequestId} is null)`,
    ),
    check("api_keys_pending_only_managed_check", sql`${table.status} <> 'PENDING' or ${table.credentialClass} = 'INTEGRATION_MANAGED'`),
  ],
);
