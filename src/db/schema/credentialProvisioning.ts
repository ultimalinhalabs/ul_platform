import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { apiKeys } from "./apiKeys.js";
import { applications } from "./applications.js";
import { contracts } from "./contracts.js";
import { entitlementGrants } from "./entitlementGrants.js";
import { organizations } from "./organizations.js";

export const PROVISIONING_KINDS = ["initial", "rotation", "rekey"] as const;
export const PROVISIONING_STATUSES = ["REQUESTED", "ISSUED", "ACTIVE", "CANCELLED", "REVOKED", "SUPERSEDED"] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];

/**
 * D2-B — a Provisioning Request: the ONLY authority under which the platform may mint an
 * INTEGRATION_MANAGED credential for one Organization × Application × purpose. A provisioner
 * credential proves "I am the product's reconciler"; it never chooses the organization or the
 * application — both are read from this row, and the commercial authorization (organization active,
 * application active, effective access, effective contractual grant) is re-evaluated at every
 * transition. Lifecycle and invariants are also enforced in the database (migration 0020):
 *  - REQUESTED → ISSUED | CANCELLED; ISSUED → ISSUED (re-issue) | ACTIVE | CANCELLED;
 *    ACTIVE → REVOKED | SUPERSEDED; CANCELLED / REVOKED / SUPERSEDED are terminal;
 *  - at most one open (REQUESTED/ISSUED) and one ACTIVE request per organization × application × purpose;
 *  - organization, application, purpose, kind, predecessor and origin are immutable; issue_count only grows.
 */
export const credentialProvisioningRequests = pgTable(
  "credential_provisioning_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    kind: text("kind", { enum: PROVISIONING_KINDS }).notNull(),
    status: text("status", { enum: PROVISIONING_STATUSES }).notNull().default("REQUESTED"),
    predecessorId: uuid("predecessor_id"),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "restrict" }),
    entitlementGrantId: uuid("entitlement_grant_id").references(() => entitlementGrants.id, { onDelete: "restrict" }),
    currentCredentialId: uuid("current_credential_id").references(() => apiKeys.id, { onDelete: "restrict" }),
    issueCount: integer("issue_count").notNull().default(0),
    requestedBy: text("requested_by").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("credential_provisioning_one_open")
      .on(table.organizationId, table.applicationId, table.purpose)
      .where(sql`${table.status} in ('REQUESTED', 'ISSUED')`),
    uniqueIndex("credential_provisioning_one_active")
      .on(table.organizationId, table.applicationId, table.purpose)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("credential_provisioning_application_status_idx").on(table.applicationId, table.status),
    check("credential_provisioning_status_check", sql`${table.status} in ('REQUESTED', 'ISSUED', 'ACTIVE', 'CANCELLED', 'REVOKED', 'SUPERSEDED')`),
    check("credential_provisioning_kind_check", sql`${table.kind} in ('initial', 'rotation', 'rekey')`),
    check("credential_provisioning_purpose_check", sql`${table.purpose} = 'platform_integration'`),
    check("credential_provisioning_issue_count_check", sql`${table.issueCount} >= 0`),
    check("credential_provisioning_predecessor_check", sql`(${table.kind} = 'initial') = (${table.predecessorId} is null)`),
    check(
      "credential_provisioning_issued_has_credential_check",
      sql`${table.status} not in ('ISSUED', 'ACTIVE') or (${table.currentCredentialId} is not null and ${table.issueCount} > 0)`,
    ),
  ],
);
