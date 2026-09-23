import "dotenv/config";

/**
 * Removes every F26 test organization/user — same pattern as
 * f19/f20/f21-teardown-fixtures.ts. Also matches `F26_TZ_PROBE_%`:
 * `scheduling-timezone.test.ts` mints extra throwaway orgs inline
 * (owned by org A's fixture user, to test a genuinely-just-created
 * membership against `resolveIdentity`'s cache) that the base
 * `F26_TEST_ORG_%` pattern alone would leave behind, blocking this
 * script's own user-deletion step on an FK.
 */
async function main() {
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { like, or } = await import("drizzle-orm");

  try {
    const deletedOrgs = await db
      .delete(organizations)
      .where(or(like(organizations.name, "F26_TEST_ORG_%"), like(organizations.name, "F26_TZ_PROBE_%")))
      .returning({ id: organizations.id });
    const deletedUsers = await db.delete(users).where(like(users.email, "f26-%@test.ul-platform.invalid")).returning({ id: users.id });
    console.log(`Deleted ${deletedOrgs.length} F26 test organization(s), ${deletedUsers.length} F26 test user(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("F26 teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
