import { sql } from "drizzle-orm";
import { check, customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contractRenewals } from "./contractRenewals.js";
import { contracts } from "./contracts.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const PAYMENT_PROOF_STATUSES = ["submitted", "accepted", "rejected"] as const;
export const PAYMENT_PROOF_METHODS = ["bank_transfer", "multicaixa_express"] as const;

/**
 * Migration 0027 — the client's proof of payment (owner decision 2026-10-16:
 * pay by IBAN transfer or Multicaixa Express, then upload the PDF). A proof
 * is NOT a payment: only a UL administrator's confirmation (or the payments
 * integration) records one (commercial_payments). A proof is `submitted`,
 * then `accepted` (the confirmation that used it) or `rejected` (with a
 * reason the client sees, so they can send another). Identity and the file
 * never change (trigger). The PDF itself lives in payment_proof_files, so
 * lists never load it.
 */
export const paymentProofs = pgTable(
  "payment_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "restrict" }),
    /** Set when the proof is for a renewal period. */
    renewalId: uuid("renewal_id").references(() => contractRenewals.id, { onDelete: "restrict" }),
    method: text("method", { enum: PAYMENT_PROOF_METHODS }).notNull(),
    /** What the client declares: the transfer reference or the Multicaixa Express operation id. */
    declaredReference: text("declared_reference").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: PAYMENT_PROOF_STATUSES }).notNull().default("submitted"),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The same file sent twice for the same period is one proof (idempotent upload).
    uniqueIndex("payment_proofs_same_file_unique").on(table.contractId, sql`coalesce(${table.renewalId}, '00000000-0000-0000-0000-000000000000'::uuid)`, table.sha256),
    index("payment_proofs_contract_idx").on(table.contractId),
    index("payment_proofs_status_idx").on(table.status, table.createdAt),
    check("payment_proofs_status_check", sql`${table.status} in ('submitted', 'accepted', 'rejected')`),
    check("payment_proofs_method_check", sql`${table.method} in ('bank_transfer', 'multicaixa_express')`),
    check("payment_proofs_reference_check", sql`length(${table.declaredReference}) between 1 and 200`),
    check("payment_proofs_file_name_check", sql`length(${table.fileName}) between 1 and 200`),
    check("payment_proofs_content_type_check", sql`${table.contentType} = 'application/pdf'`),
    check("payment_proofs_size_check", sql`${table.sizeBytes} between 1 and 4194304`),
    check("payment_proofs_sha_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("payment_proofs_review_check", sql`(${table.status} = 'submitted') = (${table.reviewedAt} is null)`),
    check("payment_proofs_rejection_check", sql`(${table.status} = 'rejected') = (${table.rejectionReason} is not null)`),
  ],
);

/** The PDF bytes (max 4 MiB — under the serverless request limit), one row per proof, never updated. */
export const paymentProofFiles = pgTable("payment_proof_files", {
  proofId: uuid("proof_id")
    .primaryKey()
    .references(() => paymentProofs.id, { onDelete: "restrict" }),
  content: bytea("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
