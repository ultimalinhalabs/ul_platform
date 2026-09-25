import "dotenv/config";

/**
 * Removes every Na Pista manual-validation organization/user created by
 * manual-validation-provision.ts: Platform organizations `MV_%_REFERENCE_%`,
 * Platform users `mv-%@test.ul-platform.invalid`, and the matching Supabase
 * Auth users (Admin API). Na Pista's own rows for those organizations are
 * removed by na-pista's `npm run mv:teardown` (separate database/repo).
 * Dev-only tooling — no UL Platform production change.
 */
const EMAIL = /^mv-.+@test\.ul-platform\.invalid$/;

async function main() {
  const { env } = await import("../src/config/env.js");
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { like } = await import("drizzle-orm");

  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  let authDeleted = 0;
  try {
    for (let page = 1; ; page++) {
      const res = await fetch(new URL(`/auth/v1/admin/users?page=${page}&per_page=200`, env.SUPABASE_URL), { headers });
      if (!res.ok) throw new Error(`Supabase list users -> ${res.status}`);
      const { users: authUsers } = (await res.json()) as { users: { id: string; email?: string }[] };
      const targets = authUsers.filter((u) => u.email && EMAIL.test(u.email));
      for (const user of targets) {
        const del = await fetch(new URL(`/auth/v1/admin/users/${user.id}`, env.SUPABASE_URL), { method: "DELETE", headers });
        if (!del.ok) throw new Error(`Supabase delete user -> ${del.status}`);
        authDeleted++;
      }
      if (authUsers.length < 200) break;
      if (targets.length > 0) page--; // deletions shift later pages
    }

    const deletedOrgs = await db.delete(organizations).where(like(organizations.name, "MV\\_%\\_REFERENCE\\_%")).returning({ id: organizations.id });
    const deletedUsers = await db.delete(users).where(like(users.email, "mv-%@test.ul-platform.invalid")).returning({ id: users.id });
    console.log(`Deleted ${deletedOrgs.length} organization(s), ${deletedUsers.length} Platform user(s), ${authDeleted} Supabase Auth user(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("Manual-validation teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
