import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { commercialTermsTemplates } from "./commercialTerms.js";
import { organizations } from "./organizations.js";
import { plans } from "./plans.js";
import { BILLING_PERIODS, COMMERCIAL_ITEM_KINDS, proposalItems, proposalOptions, proposals, proposalVersions } from "./proposals.js";
import { users } from "./users.js";

/**
 * Block 1A — the client's acceptance of ONE exact sent proposal version and
 * option, with the evidence of who/when/what (content hash, consent text
 * hash, IP, user agent). At most one per proposal; append-only. A DB trigger
 * (migration 0018) checks that the version belongs to the proposal, the
 * option to the version, the version is `sent`, and the hash and terms match
 * the frozen version.
 */
export const proposalAcceptances = pgTable(
  "proposal_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "restrict" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersions.id, { onDelete: "restrict" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => proposalOptions.id, { onDelete: "restrict" }),
    contentSha256: text("content_sha256").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    acceptedByUserId: uuid("accepted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    signerName: text("signer_name").notNull(),
    signerTitle: text("signer_title"),
    signerEmail: text("signer_email").notNull(),
    termsTemplateId: uuid("terms_template_id")
      .notNull()
      .references(() => commercialTermsTemplates.id, { onDelete: "restrict" }),
    consentText: text("consent_text").notNull(),
    consentSha256: text("consent_sha256").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    idempotencyKey: text("idempotency_key").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("proposal_acceptances_proposal_unique").on(table.proposalId),
    unique("proposal_acceptances_idempotency_unique").on(table.idempotencyKey),
    index("proposal_acceptances_organization_idx").on(table.organizationId),
    check("proposal_acceptances_content_sha_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("proposal_acceptances_consent_sha_check", sql`${table.consentSha256} ~ '^[0-9a-f]{64}$'`),
    check("proposal_acceptances_signer_email_check", sql`${table.signerEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
    check("proposal_acceptances_idempotency_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  ],
);

export const CONTRACT_STATUSES = ["pending_activation", "active", "suspended", "terminated", "expired", "cancelled"] as const;

/**
 * The contract lives inside the platform. Exactly one per acceptance
 * (`source_acceptance_id` unique), RESTRICT towards organizations so
 * deleting an organization can never erase contractual history. Status
 * transitions belong to the (future) commercial services, never to a
 * generic PATCH.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceAcceptanceId: uuid("source_acceptance_id")
      .notNull()
      .references(() => proposalAcceptances.id, { onDelete: "restrict" }),
    status: text("status", { enum: CONTRACT_STATUSES }).notNull().default("pending_activation"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => contractVersions.id, { onDelete: "restrict" }),
    currency: text("currency").notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    renewalPolicy: text("renewal_policy", { enum: ["none", "manual"] }).notNull().default("none"),
    ...timestamps,
  },
  (table) => [
    unique("contracts_number_unique").on(table.number),
    unique("contracts_source_acceptance_unique").on(table.sourceAcceptanceId),
    index("contracts_organization_idx").on(table.organizationId),
    index("contracts_status_idx").on(table.status),
    check(
      "contracts_status_check",
      sql`${table.status} in ('pending_activation', 'active', 'suspended', 'terminated', 'expired', 'cancelled')`,
    ),
    check("contracts_number_check", sql`${table.number} ~ '^UL-C-[0-9]{4}-[0-9]{6,}$'`),
    check("contracts_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("contracts_total_check", sql`${table.totalMinor} >= 0`),
    check("contracts_period_check", sql`${table.endsAt} is null or ${table.startsAt} is null or ${table.endsAt} > ${table.startsAt}`),
    check("contracts_renewal_policy_check", sql`${table.renewalPolicy} in ('none', 'manual')`),
  ],
);

/** Immutable versions of a contract (v1 = the accepted option); a change is a new version, never an edit. Append-only. */
export const contractVersions = pgTable(
  "contract_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    parties: jsonb("parties").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    contentSha256: text("content_sha256").notNull(),
    termsTemplateId: uuid("terms_template_id")
      .notNull()
      .references(() => commercialTermsTemplates.id, { onDelete: "restrict" }),
    termsSha256: text("terms_sha256").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("contract_versions_contract_version_unique").on(table.contractId, table.versionNo),
    check("contract_versions_version_no_check", sql`${table.versionNo} > 0`),
    check("contract_versions_content_sha_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("contract_versions_terms_sha_check", sql`${table.termsSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** The commercial photograph of each accepted item, copied — never read back from the (mutable-until-sent) proposal. Append-only. */
export const contractItems = pgTable(
  "contract_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractVersionId: uuid("contract_version_id")
      .notNull()
      .references(() => contractVersions.id, { onDelete: "restrict" }),
    sourceProposalItemId: uuid("source_proposal_item_id").references(() => proposalItems.id, { onDelete: "restrict" }),
    sort: integer("sort").notNull().default(0),
    kind: text("kind", { enum: COMMERCIAL_ITEM_KINDS }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }).notNull(),
    durationMonths: integer("duration_months"),
    entitlementSpec: jsonb("entitlement_spec"),
    ...timestamps,
  },
  (table) => [
    index("contract_items_version_idx").on(table.contractVersionId),
    check("contract_items_kind_check", sql`${table.kind} in ('application_plan', 'service', 'support', 'one_off', 'custom')`),
    check("contract_items_plan_check", sql`${table.kind} <> 'application_plan' or (${table.planId} is not null and ${table.applicationId} is not null)`),
    check("contract_items_quantity_check", sql`${table.quantity} > 0`),
    check("contract_items_unit_price_check", sql`${table.unitPriceMinor} >= 0`),
    check("contract_items_line_total_check", sql`${table.lineTotalMinor} = ${table.quantity}::bigint * ${table.unitPriceMinor}`),
    check("contract_items_billing_period_check", sql`${table.billingPeriod} in ('one_time', 'monthly', 'yearly')`),
    check("contract_items_duration_check", sql`${table.durationMonths} is null or ${table.durationMonths} > 0`),
    check("contract_items_sort_check", sql`${table.sort} >= 0`),
  ],
);
