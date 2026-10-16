import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./apiKeys.js";
import { contracts } from "./contracts.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Payment confirmations of contracts — the third activation condition
 * (organization active + terms accepted and recorded + payment confirmed).
 * UL Platform does NOT move money or issue invoices: a row only records that
 * a trusted source confirmed the contract's amount was received.
 *
 *  - `manual`: a platform administrator holding `platform.payment.confirm`
 *    (POST /v1/platform/contracts/:id/payments) — `confirmed_by_user_id`;
 *  - `integration`: an authenticated PLATFORM_SERVICE credential of the
 *    payments application holding `payment.confirm`
 *    (POST /v1/service/payments/confirmations) — `confirmed_by_api_key_id`.
 *
 * Amount and currency must equal the contract's (checked by the service and
 * again by the insert trigger, migration 0023). At most one CONFIRMED
 * payment per contract (no partial payments in this phase); an external
 * reference is unique per source, so the same bank/integration reference
 * can never confirm twice. Append-only (history), like every commercial
 * record.
 */
export const PAYMENT_SOURCES = ["manual", "integration"] as const;
export const PAYMENT_STATUSES = ["confirmed"] as const;

export const commercialPayments = pgTable(
  "commercial_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull().default("confirmed"),
    source: text("source", { enum: PAYMENT_SOURCES }).notNull(),
    /** Short code of how the money arrived (e.g. `bank_transfer`); the accepted list is a UL operational decision, not fixed here. */
    method: text("method").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    externalReference: text("external_reference").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    confirmedByApiKeyId: uuid("confirmed_by_api_key_id").references(() => apiKeys.id, { onDelete: "restrict" }),
    /** Internal pointer to the evidence (document id, ticket) — never the document itself nor personal data. */
    evidenceReference: text("evidence_reference"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("commercial_payments_idempotency_unique").on(table.idempotencyKey),
    unique("commercial_payments_reference_unique").on(table.source, table.externalReference),
    uniqueIndex("commercial_payments_one_confirmed_per_contract").on(table.contractId).where(sql`${table.status} = 'confirmed'`),
    index("commercial_payments_organization_idx").on(table.organizationId),
    check("commercial_payments_status_check", sql`${table.status} in ('confirmed')`),
    check("commercial_payments_source_check", sql`${table.source} in ('manual', 'integration')`),
    check("commercial_payments_method_check", sql`${table.method} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check("commercial_payments_amount_check", sql`${table.amountMinor} >= 0`),
    check("commercial_payments_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("commercial_payments_reference_check", sql`length(${table.externalReference}) between 1 and 200`),
    check("commercial_payments_evidence_check", sql`${table.evidenceReference} is null or length(${table.evidenceReference}) between 1 and 500`),
    check("commercial_payments_idempotency_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
    check(
      "commercial_payments_confirmer_check",
      sql`(${table.source} = 'manual' and ${table.confirmedByUserId} is not null and ${table.confirmedByApiKeyId} is null)
        or (${table.source} = 'integration' and ${table.confirmedByApiKeyId} is not null and ${table.confirmedByUserId} is null)`,
    ),
  ],
);
