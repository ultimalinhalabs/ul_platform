import { eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Ensures a platform-side mirror row exists for a Supabase identity.
 * Called from `authenticate` on every request, so first-seen users don't
 * need a separate signup step before touching platform resources.
 *
 * Cost/behavior analysis (v1 decision — see CLAUDE.md §15):
 * - Runs once per authenticated request. On the common case (row already
 *   exists, email unchanged) this issues one UPDATE whose WHERE clause
 *   excludes rows where the email already matches, so Postgres does not
 *   rewrite the row or generate WAL/dead-tuple bloat — the query still
 *   round-trips, but it is a cheap single-row indexed write attempt.
 * - `INSERT ... ON CONFLICT` is atomic, so concurrent first-time requests
 *   from the same user race safely to one row: no duplicate-key exception,
 *   no lost update.
 * - This is a real per-request DB round trip and won't scale indefinitely.
 *   The correct v2 fix is event-driven: consume Supabase Auth's
 *   user.created/user.updated webhooks to sync `users` out-of-band, and
 *   drop this call from the hot path entirely. Deferred for now — v1
 *   prioritizes correctness/simplicity over this optimization.
 */
/** Fase 6 — platform-admin operation: disable or reactivate a user (audited). Never touches the IdP. */
export async function setUserStatus(input: { userId: string; status: "active" | "disabled"; actorUserId: string }) {
  const [current] = await db.select({ status: users.status }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (!current) throw new NotFoundError("User not found");
  const [updated] = await db
    .update(users)
    .set({ status: input.status, updatedAt: sql`now()` })
    .where(eq(users.id, input.userId))
    .returning({ id: users.id, status: users.status });
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    action: input.status === "disabled" ? "user.disabled" : "user.reactivated",
    targetType: "user",
    targetId: input.userId,
    metadata: { previousStatus: current.status, status: input.status },
  });
  return updated!;
}

/** Fase 6 — the platform's own verdict on whether this identity may operate. */
export async function getUserStatus(userId: string): Promise<"active" | "disabled" | null> {
  const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.status ?? null;
}

/**
 * Fase 6 — whether the IdP has confirmed this user's email, read server-side
 * from `auth.users.email_confirmed_at` (same Supabase project). Never from
 * JWT `user_metadata`, which the user can edit. Databases without the
 * Supabase `auth` schema (local/CI) report `false` — fail closed.
 */
let authUsersTableExists: Promise<boolean> | null = null;

export async function isEmailVerified(userId: string): Promise<boolean> {
  // `auth.users` is resolved at parse time, so its existence is checked in a separate query (cached per process).
  authUsersTableExists ??= (
    db.execute(sql`select to_regclass('auth.users') is not null as present`) as unknown as Promise<Array<{ present: boolean }>>
  ).then((rows) => rows[0]?.present === true);
  if (!(await authUsersTableExists)) return false;
  const rows = (await db.execute(
    sql`select exists (select 1 from auth.users where id = ${userId} and email_confirmed_at is not null) as verified`,
  )) as unknown as Array<{ verified: boolean }>;
  return rows[0]?.verified === true;
}

export async function ensureUserExists(input: { id: string; email: string | undefined }) {
  const email = input.email ?? "";
  await db
    .insert(users)
    .values({ id: input.id, email })
    .onConflictDoUpdate({
      target: users.id,
      set: { email, updatedAt: sql`now()` },
      setWhere: sql`${users.email} is distinct from ${email}`,
    });
}
