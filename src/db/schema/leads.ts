import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { apiKeys } from "./apiKeys.js";
import { applications } from "./applications.js";

export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * A commercial contact request addressed to Última Linha itself (e.g. the
 * "fale connosco" form of the UL landing page) — the top of UL's own
 * commercial pipeline, before any proposal exists. NOT a product's
 * customer/CRM record: Na Pista, QD, etc. keep their own contacts.
 *
 * Written only by a PLATFORM_SERVICE credential holding `lead.create`
 * (`POST /v1/service/leads`); the browser never reaches this API. The source
 * application is the credential's own stored application, never a request
 * field, so one landing cannot write leads as another.
 *
 * Idempotency is a database constraint: the caller's `Idempotency-Key` is
 * unique per source application, so a retried submission resolves to the
 * original row (`modules/leads/service.ts`), never a duplicate lead.
 *
 * No organization/user FK: a lead is a prospect, not yet an identity or a
 * tenant. Contains personal data — readable only through the API (RLS on,
 * no Data API grants — migration 0021).
 */
export const commercialLeads = pgTable(
  "commercial_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceApplicationId: uuid("source_application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    createdByApiKeyId: uuid("created_by_api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("NEW"),
    companyName: text("company_name").notNull(),
    contactName: text("contact_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    businessArea: text("business_area").notNull(),
    desiredService: text("desired_service").notNull(),
    message: text("message").notNull(),
    landingPage: text("landing_page"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("commercial_leads_idempotency_unique").on(table.sourceApplicationId, table.idempotencyKey),
    index("commercial_leads_created_at_idx").on(table.createdAt),
    index("commercial_leads_email_idx").on(table.email),
    check("commercial_leads_status_check", sql`${table.status} in ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST')`),
    check("commercial_leads_idempotency_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  ],
);
