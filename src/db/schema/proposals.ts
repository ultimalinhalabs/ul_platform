import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";
import { commercialTermsTemplates } from "./commercialTerms.js";
import { organizations } from "./organizations.js";
import { plans } from "./plans.js";
import { users } from "./users.js";

/**
 * Block 1A — commercial domain, proposal side. Money is ALWAYS `bigint`
 * minor units + an explicit ISO-4217-shaped currency (AOA today, never
 * hard-coded); quantities are positive integers. History never disappears in
 * cascade: references to organizations/users/applications/plans are
 * RESTRICT and rows cannot be physically deleted once they are history
 * (triggers in migration 0017).
 *
 * Source of truth: while a version is `draft` its normalized rows
 * (options/items) are the truth and are editable; sending freezes it —
 * `snapshot` (canonical JSON) + `content_sha256` become the truth, and the
 * rows are locked by triggers.
 */

export const PROPOSAL_STATUSES = ["draft", "sent", "viewed", "negotiation", "accepted", "rejected", "expired", "withdrawn"] as const;
export const PROPOSAL_VERSION_STATUSES = ["draft", "sent", "superseded", "withdrawn"] as const;
export const COMMERCIAL_ITEM_KINDS = ["application_plan", "service", "support", "one_off", "custom"] as const;
export const BILLING_PERIODS = ["one_time", "monthly", "yearly"] as const;

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull().default("draft"),
    prospectCompanyName: text("prospect_company_name").notNull(),
    prospectTaxId: text("prospect_tax_id"),
    recipientName: text("recipient_name").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => proposalVersions.id, { onDelete: "restrict" }),
    acceptedVersionId: uuid("accepted_version_id").references((): AnyPgColumn => proposalVersions.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("proposals_number_unique").on(table.number),
    index("proposals_status_idx").on(table.status),
    index("proposals_organization_idx").on(table.organizationId),
    index("proposals_recipient_email_idx").on(sql`lower(${table.recipientEmail})`),
    check(
      "proposals_status_check",
      sql`${table.status} in ('draft', 'sent', 'viewed', 'negotiation', 'accepted', 'rejected', 'expired', 'withdrawn')`,
    ),
    check("proposals_number_check", sql`${table.number} ~ '^UL-P-[0-9]{4}-[0-9]{6,}$'`),
    check("proposals_recipient_email_check", sql`${table.recipientEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
    check("proposals_accepted_check", sql`(${table.status} = 'accepted') = (${table.acceptedVersionId} is not null)`),
  ],
);

export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    status: text("status", { enum: PROPOSAL_VERSION_STATUSES }).notNull().default("draft"),
    currency: text("currency").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    summary: text("summary"),
    notes: text("notes"),
    termsTemplateId: uuid("terms_template_id").references(() => commercialTermsTemplates.id, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot"),
    contentSha256: text("content_sha256"),
    hashAlg: text("hash_alg").notNull().default("sha256-jcs-v1"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("proposal_versions_proposal_version_unique").on(table.proposalId, table.versionNo),
    uniqueIndex("proposal_versions_one_draft").on(table.proposalId).where(sql`${table.status} = 'draft'`),
    uniqueIndex("proposal_versions_one_sent").on(table.proposalId).where(sql`${table.status} = 'sent'`),
    check("proposal_versions_status_check", sql`${table.status} in ('draft', 'sent', 'superseded', 'withdrawn')`),
    check("proposal_versions_version_no_check", sql`${table.versionNo} > 0`),
    check("proposal_versions_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("proposal_versions_hash_alg_check", sql`${table.hashAlg} in ('sha256-jcs-v1')`),
    check(
      "proposal_versions_frozen_check",
      sql`(${table.status} = 'draft' and ${table.sentAt} is null and ${table.snapshot} is null and ${table.contentSha256} is null)
        or (${table.status} <> 'draft' and ${table.sentAt} is not null and ${table.sentBy} is not null and ${table.snapshot} is not null
            and ${table.contentSha256} ~ '^[0-9a-f]{64}$' and ${table.termsTemplateId} is not null and ${table.validUntil} is not null)`,
    ),
  ],
);

export const proposalOptions = pgTable(
  "proposal_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersions.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
    name: text("name").notNull(),
    summary: text("summary"),
    isRecommended: boolean("is_recommended").notNull().default(false),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull().default(sql`0`),
    ...timestamps,
  },
  (table) => [
    index("proposal_options_version_idx").on(table.versionId),
    uniqueIndex("proposal_options_one_recommended").on(table.versionId).where(sql`${table.isRecommended}`),
    check("proposal_options_total_check", sql`${table.totalMinor} >= 0`),
    check("proposal_options_sort_check", sql`${table.sort} >= 0`),
  ],
);

export const proposalItems = pgTable(
  "proposal_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    optionId: uuid("option_id")
      .notNull()
      .references(() => proposalOptions.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
    kind: text("kind", { enum: COMMERCIAL_ITEM_KINDS }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    billingPeriod: text("billing_period", { enum: BILLING_PERIODS }).notNull().default("one_time"),
    durationMonths: integer("duration_months"),
    entitlementSpec: jsonb("entitlement_spec"),
    ...timestamps,
  },
  (table) => [
    index("proposal_items_option_idx").on(table.optionId),
    check("proposal_items_kind_check", sql`${table.kind} in ('application_plan', 'service', 'support', 'one_off', 'custom')`),
    check("proposal_items_plan_check", sql`${table.kind} <> 'application_plan' or (${table.planId} is not null and ${table.applicationId} is not null)`),
    check("proposal_items_quantity_check", sql`${table.quantity} > 0`),
    check("proposal_items_unit_price_check", sql`${table.unitPriceMinor} >= 0`),
    check("proposal_items_line_total_check", sql`${table.lineTotalMinor} = ${table.quantity}::bigint * ${table.unitPriceMinor}`),
    check("proposal_items_billing_period_check", sql`${table.billingPeriod} in ('one_time', 'monthly', 'yearly')`),
    check("proposal_items_duration_check", sql`${table.durationMonths} is null or ${table.durationMonths} > 0`),
    check("proposal_items_sort_check", sql`${table.sort} >= 0`),
  ],
);

/**
 * Read-only access links. The token itself is NEVER stored — only its
 * SHA-256 (the token is 256 random bits, so a fast hash is sufficient).
 * A link authorises reading only; it never authorises accepting.
 */
export const proposalAccessLinks = pgTable(
  "proposal_access_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "restrict" }),
    tokenSha256: text("token_sha256").notNull(),
    kind: text("kind", { enum: ["recipient", "internal_preview"] }).notNull().default("recipient"),
    recipientEmail: text("recipient_email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxViews: integer("max_views"),
    viewCount: integer("view_count").notNull().default(0),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("proposal_access_links_token_unique").on(table.tokenSha256),
    index("proposal_access_links_proposal_idx").on(table.proposalId),
    check("proposal_access_links_token_check", sql`${table.tokenSha256} ~ '^[0-9a-f]{64}$'`),
    check("proposal_access_links_kind_check", sql`${table.kind} in ('recipient', 'internal_preview')`),
    check("proposal_access_links_views_check", sql`${table.viewCount} >= 0 and (${table.maxViews} is null or ${table.maxViews} > 0)`),
    check("proposal_access_links_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    check("proposal_access_links_revoked_check", sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`),
  ],
);
