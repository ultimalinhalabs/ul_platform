import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const EMAIL_OUTBOX_STATUSES = ["pending", "sent", "failed"] as const;

/**
 * Migration 0028 — transactional emails (owner decision 2026-10-16: team
 * invitations are emailed automatically). A message is written in the SAME
 * transaction as the business fact that causes it (invitation created,
 * renewal prepared, proof received/rejected), so it is never lost and never
 * sent for a change that rolled back; the worker delivers it over SMTP with
 * retries (claimed with FOR UPDATE SKIP LOCKED + a lease). `dedupe_key`
 * makes enqueueing idempotent. Holds personal data (the recipient): RLS on,
 * no Data API access; the body never contains secrets or tokens.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: EMAIL_OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("email_outbox_dedupe_unique").on(table.dedupeKey),
    index("email_outbox_due_idx").on(table.status, table.nextAttemptAt),
    check("email_outbox_status_check", sql`${table.status} in ('pending', 'sent', 'failed')`),
    check("email_outbox_kind_check", sql`${table.kind} ~ '^[a-z][a-z0-9_.]{2,60}$'`),
    check("email_outbox_to_check", sql`${table.toEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
    check("email_outbox_subject_check", sql`length(${table.subject}) between 1 and 300`),
    check("email_outbox_attempts_check", sql`${table.attempts} >= 0`),
    check("email_outbox_sent_check", sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`),
  ],
);
