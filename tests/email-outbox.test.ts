import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { emailOutbox, memberships, roles } from "../src/db/schema/index.js";
import { seed } from "../src/db/seed/index.js";
import { createInvitation } from "../src/modules/memberships/invitations.service.js";
import { MAX_ATTEMPTS, deliverDueEmails, enqueueEmail } from "../src/modules/email/outbox.js";
import { formatMoney, invitationEmail } from "../src/modules/email/templates.js";
import { createTestOrganization, createTestUser } from "./helpers.js";

/**
 * Migration 0028 — transactional email outbox: enqueued in the business transaction (never for a rollback),
 * idempotent by dedupe key, delivered by the worker with retries/backoff and a final `failed` state, claimed
 * safely by concurrent workers. The SMTP sender is replaced by a fake here (no network).
 */

const tag = `outbox-${randomUUID().slice(0, 8)}`;
const mine = like(emailOutbox.dedupeKey, `${tag}:%`);

before(async () => {
  await seed();
  // Leave other suites' pending messages alone: park them while this suite runs.
  await db.execute(sql`update email_outbox set next_attempt_at = now() + interval '1 day' where status = 'pending' and dedupe_key not like ${`${tag}:%`}`);
});

after(async () => {
  await queryClient.end();
});

test("templates: Portuguese text and escaped HTML, money and dates formatted for Angola", () => {
  const m = invitationEmail({ organizationName: "Loja <Teste> & Filhos", roleKey: "STAFF", expiresAt: new Date("2026-10-23T10:00:00Z"), acceptUrl: "https://platform.ultimalinha.ao/app/invitations" });
  assert.match(m.subject, /Loja <Teste> & Filhos/);
  assert.match(m.text, /como Colaborador/);
  assert.match(m.text, /23 de outubro de 2026/);
  assert.ok(m.html!.includes("Loja &lt;Teste&gt; &amp; Filhos"), "HTML is escaped");
  assert.ok(!m.html!.includes("<Teste>"));
  assert.equal(formatMoney(2500000n, "AOA"), "25 000,00 Kz");
  assert.equal(formatMoney("123456789", "AOA"), "1 234 567,89 Kz");
});

test("enqueue is idempotent by dedupe key and rolls back with its transaction", async () => {
  const key = `${tag}:idem`;
  await enqueueEmail(db, { kind: "test.kind", to: "Pessoa@Example.com", dedupeKey: key, subject: "S", text: "T" });
  await enqueueEmail(db, { kind: "test.kind", to: "pessoa@example.com", dedupeKey: key, subject: "S2", text: "T2" });
  const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, key));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toEmail, "pessoa@example.com");
  const rolledBack = `${tag}:rollback`;
  await assert.rejects(
    db.transaction(async (tx) => {
      await enqueueEmail(tx, { kind: "test.kind", to: "x@example.com", dedupeKey: rolledBack, subject: "S", text: "T" });
      throw new Error("business failure");
    }),
  );
  assert.equal((await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, rolledBack))).length, 0);
});

test("an invitation queues its email in the same transaction (to the invited address, with the acceptance link)", async () => {
  const owner = await createTestUser("outbox-owner");
  const org = await createTestOrganization("outbox-org", owner.id);
  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "OWNER"));
  await db.insert(memberships).values({ userId: owner.id, organizationId: org.id, roleId: ownerRole!.id, status: "active" });
  const email = `convidado-${randomUUID().slice(0, 8)}@example.com`;
  const inv = await createInvitation({ organizationId: org.id, email, roleKey: "STAFF", actorUserId: owner.id, actorRoleKey: "OWNER" });
  const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, `membership.invitation:${inv.id}`));
  assert.ok(row, "queued");
  assert.equal(row!.toEmail, email);
  assert.equal(row!.kind, "membership.invitation");
  assert.match(row!.bodyText, /\/app\/invitations/);
  assert.match(row!.subject, /Convite para a equipa de/);
});

test("delivery: sent once; a failure is retried with backoff; after the last attempt it is failed", async () => {
  const ok = `${tag}:ok`;
  const bad = `${tag}:bad`;
  await enqueueEmail(db, { kind: "test.kind", to: "ok@example.com", dedupeKey: ok, subject: "S", text: "T" });
  await enqueueEmail(db, { kind: "test.kind", to: "bad@example.com", dedupeKey: bad, subject: "S", text: "T" });
  const sentTo: string[] = [];
  const sender = async (row: typeof emailOutbox.$inferSelect) => {
    if (row.toEmail === "bad@example.com") throw Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
    sentTo.push(row.toEmail);
  };
  const r1 = await deliverDueEmails(50, sender);
  assert.ok(r1.sent >= 1);
  assert.ok(sentTo.includes("ok@example.com"));
  const [okRow] = await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, ok));
  assert.equal(okRow!.status, "sent");
  assert.ok(okRow!.sentAt);
  const [badRow] = await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, bad));
  assert.equal(badRow!.status, "pending");
  assert.equal(badRow!.attempts, 1);
  assert.equal(badRow!.lastErrorCode, "SMTP_550");
  assert.ok(badRow!.nextAttemptAt.getTime() > Date.now() + 30_000, "backed off");
  // Not due yet: nothing happens; a sent message is never sent again.
  sentTo.length = 0;
  await deliverDueEmails(50, sender);
  assert.ok(!sentTo.includes("ok@example.com"));
  // Exhaust the attempts.
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await db.update(emailOutbox).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(emailOutbox.dedupeKey, bad));
    await deliverDueEmails(50, sender);
  }
  const [final] = await db.select().from(emailOutbox).where(eq(emailOutbox.dedupeKey, bad));
  assert.equal(final!.status, "failed");
  assert.equal(final!.attempts, MAX_ATTEMPTS);
});

test("concurrent workers never send the same message twice (claim with SKIP LOCKED + lease)", async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `${tag}:conc-${i}`);
  for (const k of keys) await enqueueEmail(db, { kind: "test.kind", to: `${k.split(":")[1]}@example.com`, dedupeKey: k, subject: "S", text: "T" });
  const sent: string[] = [];
  const sender = async (row: typeof emailOutbox.$inferSelect) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sent.push(row.dedupeKey);
  };
  await Promise.all(Array.from({ length: 4 }, () => deliverDueEmails(5, sender)));
  await deliverDueEmails(50, sender);
  const mineSent = sent.filter((k) => keys.includes(k));
  assert.equal(mineSent.length, keys.length, "each message once");
  assert.equal(new Set(mineSent).size, keys.length);
  const rows = await db.select().from(emailOutbox).where(inArray(emailOutbox.dedupeKey, keys));
  assert.ok(rows.every((r) => r.status === "sent"));
});

test("cleanup marker", async () => {
  // Test rows are history like any outbox row; nothing to delete. Restore other suites' parked messages.
  await db.execute(sql`update email_outbox set next_attempt_at = now() where status = 'pending' and dedupe_key not like ${`${tag}:%`} and next_attempt_at > now() + interval '12 hours'`);
  assert.ok(mine);
});
