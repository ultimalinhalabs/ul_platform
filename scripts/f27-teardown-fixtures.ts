import "dotenv/config";

/**
 * Removes every F27 test organization/user — same pattern as
 * f19..f26-teardown-fixtures.ts. Also matches `F27_TZ_PROBE_%`, reserved
 * for throwaway orgs a test may mint inline (e.g. a fresh org without a
 * configured timezone), so user deletion is never blocked by an FK.
 */
async function main() {
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { like, or } = await import("drizzle-orm");

  try {
    const deletedOrgs = await db
      .delete(organizations)
      .where(or(like(organizations.name, "F27_TEST_ORG_%"), like(organizations.name, "F27_TZ_PROBE_%")))
      .returning({ id: organizations.id });
    const deletedUsers = await db.delete(users).where(like(users.email, "f27-%@test.ul-platform.invalid")).returning({ id: users.id });
    console.log(`Deleted ${deletedOrgs.length} F27 test organization(s), ${deletedUsers.length} F27 test user(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("F27 teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
