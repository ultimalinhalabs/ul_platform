import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { contracts } from "./contracts.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Migration 0026 — renewal (spec §6.2, T11–T13). Renewal is NOT recurring
 * billing: an OWNER gives an express, recorded authorization (the exact text,
 * its hash, the price and the period it covers); while it stands, the worker
 * prepares the next period `awaiting_payment` before the current one ends,
 * and that period becomes active ONLY after its payment is confirmed (once).
 * Withdrawing the authorization stops future renewals and cancels an unpaid
 * one. Without a valid, paid renewal, access ends with the period.
 *
 * Authorizations are history: inserted, then at most withdrawn once (trigger).
 * At most one standing (not withdrawn) authorization per contract.
 */
export const contractRenewalAuthorizations = pgTable(
  "contract_renewal_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    authorizedByUserId: uuid("authorized_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The price and period the person authorized — each renewal must match them. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    periodDays: integer("period_days").notNull(),
    consentText: text("consent_text").notNull(),
    consentSha256: text("consent_sha256").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: uuid("withdrawn_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("contract_renewal_authorizations_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("contract_renewal_authorizations_one_standing").on(table.contractId).where(sql`${table.withdrawnAt} is null`),
    index("contract_renewal_authorizations_organization_idx").on(table.organizationId),
    check("contract_renewal_authorizations_amount_check", sql`${table.amountMinor} >= 0`),
    check("contract_renewal_authorizations_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("contract_renewal_authorizations_period_check", sql`${table.periodDays} between 1 and 3660`),
    check("contract_renewal_authorizations_consent_sha_check", sql`${table.consentSha256} ~ '^[0-9a-f]{64}$'`),
    check("contract_renewal_authorizations_idempotency_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
    check("contract_renewal_authorizations_withdrawn_check", sql`(${table.withdrawnAt} is null) = (${table.withdrawnByUserId} is null)`),
  ],
);

export const CONTRACT_RENEWAL_STATUSES = ["awaiting_payment", "active", "cancelled", "lapsed"] as const;

/**
 * One renewal period of a contract: created `awaiting_payment` (spec:
 * renewal_pending/awaiting_payment), then exactly one of
 *  - `active`    — its payment was confirmed and the period applied (contract, grants and subscription end moved to period_ends_at);
 *  - `cancelled` — the authorization was withdrawn before it was paid;
 *  - `lapsed`    — the current period ended without a confirmed payment (access ends).
 * The period always starts where the contract's period ended; numbered per contract.
 */
export const contractRenewals = pgTable(
  "contract_renewals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => contractRenewalAuthorizations.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    status: text("status", { enum: CONTRACT_RENEWAL_STATUSES }).notNull().default("awaiting_payment"),
    periodStartsAt: timestamp("period_starts_at", { withTimezone: true }).notNull(),
    periodEndsAt: timestamp("period_ends_at", { withTimezone: true }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lapsedAt: timestamp("lapsed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("contract_renewals_sequence_unique").on(table.contractId, table.sequence),
    unique("contract_renewals_period_unique").on(table.contractId, table.periodStartsAt),
    uniqueIndex("contract_renewals_one_awaiting").on(table.contractId).where(sql`${table.status} = 'awaiting_payment'`),
    index("contract_renewals_organization_idx").on(table.organizationId),
    index("contract_renewals_status_idx").on(table.status, table.periodStartsAt),
    check("contract_renewals_status_check", sql`${table.status} in ('awaiting_payment', 'active', 'cancelled', 'lapsed')`),
    check("contract_renewals_sequence_check", sql`${table.sequence} > 0`),
    check("contract_renewals_period_check", sql`${table.periodEndsAt} > ${table.periodStartsAt}`),
    check("contract_renewals_amount_check", sql`${table.amountMinor} >= 0`),
    check("contract_renewals_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("contract_renewals_applied_check", sql`(${table.status} = 'active') = (${table.appliedAt} is not null)`),
    check("contract_renewals_cancelled_check", sql`(${table.status} = 'cancelled') = (${table.cancelledAt} is not null)`),
    check("contract_renewals_lapsed_check", sql`(${table.status} = 'lapsed') = (${table.lapsedAt} is not null)`),
  ],
);
