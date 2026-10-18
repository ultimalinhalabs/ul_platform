import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { emailOutbox } from "../../db/schema/index.js";
import { logger } from "../../shared/logger.js";
import type { EmailMessage } from "./templates.js";

/**
 * Migration 0028 — the transactional outbox. `enqueueEmail` is called with
 * the caller's transaction, so the message exists if and only if the fact
 * that caused it committed; `dedupe_key` makes it idempotent. The worker
 * (`deliverDueEmails`) claims due messages with FOR UPDATE SKIP LOCKED and a
 * lease (several replicas are safe), sends them over SMTP and retries with
 * backoff; after MAX_ATTEMPTS a message is `failed` (kept for inspection).
 * Logs never contain the recipient or the body.
 */

type Executor = Pick<typeof db, "insert">;

export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 120;

export async function enqueueEmail(executor: Executor, message: EmailMessage & { kind: string; to: string; dedupeKey: string }): Promise<void> {
  await executor
    .insert(emailOutbox)
    .values({ kind: message.kind, toEmail: message.to.toLowerCase(), subject: message.subject, bodyText: message.text, bodyHtml: message.html ?? null, dedupeKey: message.dedupeKey })
    .onConflictDoNothing({ target: emailOutbox.dedupeKey });
}

export function smtpConfigured(): boolean {
  return !!env.SMTP_HOST;
}

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter;
}

/** Test seam: replace the SMTP sender (returns a provider id or throws). */
export type EmailSender = (row: typeof emailOutbox.$inferSelect) => Promise<void>;
const smtpSender: EmailSender = async (row) => {
  await getTransporter().sendMail({
    from: env.EMAIL_FROM,
    to: row.toEmail,
    replyTo: env.EMAIL_REPLY_TO,
    subject: row.subject,
    text: row.bodyText,
    html: row.bodyHtml ?? undefined,
  });
};

/** Backoff: 1, 2, 4 … minutes, capped at 6 h. */
function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

function errorCode(error: unknown): string {
  const e = error as { code?: unknown; responseCode?: unknown; name?: unknown };
  const code = typeof e?.code === "string" ? e.code : typeof e?.responseCode === "number" ? `SMTP_${e.responseCode}` : typeof e?.name === "string" ? e.name : "UNKNOWN";
  return code.slice(0, 60);
}

export async function deliverDueEmails(limit = 20, send: EmailSender = smtpSender): Promise<{ sent: number; failed: number; retried: number }> {
  if (send === smtpSender && !smtpConfigured()) return { sent: 0, failed: 0, retried: 0 };
  // Claim (lease) due messages in one short transaction.
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, "pending"), lte(emailOutbox.nextAttemptAt, sql`now()`), or(isNull(emailOutbox.lockedUntil), lte(emailOutbox.lockedUntil, sql`now()`))))
      .orderBy(emailOutbox.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(emailOutbox)
      .set({ lockedUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`, updatedAt: sql`now()` })
      .where(inArray(emailOutbox.id, due.map((d) => d.id)))
      .returning();
  });
  const result = { sent: 0, failed: 0, retried: 0 };
  for (const row of claimed) {
    try {
      await send(row);
      await db.update(emailOutbox).set({ status: "sent", sentAt: sql`now()`, attempts: row.attempts + 1, lockedUntil: null, lastErrorCode: null, updatedAt: sql`now()` }).where(eq(emailOutbox.id, row.id));
      result.sent++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await db
        .update(emailOutbox)
        .set({
          status: final ? "failed" : "pending",
          attempts,
          lockedUntil: null,
          lastErrorCode: errorCode(error),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds(attempts)})`,
          updatedAt: sql`now()`,
        })
        .where(eq(emailOutbox.id, row.id));
      logger.warn("Email delivery failed", { event: "email.delivery.failed", emailId: row.id, kind: row.kind, attempts, final, errorCode: errorCode(error) });
      if (final) result.failed++;
      else result.retried++;
    }
  }
  return result;
}
