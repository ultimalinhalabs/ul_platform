import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/index.js";

/**
 * Ensures a platform-side mirror row exists for a Supabase identity.
 * Called on authentication; cheap upsert so first-seen users don't need a
 * separate signup step before touching platform resources.
 */
export async function ensureUserExists(input: { id: string; email: string | undefined }) {
  await db
    .insert(users)
    .values({ id: input.id, email: input.email ?? "" })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: input.email ?? "", updatedAt: sql`now()` },
    });
}
