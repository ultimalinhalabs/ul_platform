import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";

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
