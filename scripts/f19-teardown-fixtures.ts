import "dotenv/config";

/**
 * Removes every F19 test organization (name LIKE 'F19\_TEST\_ORG\_%') and,
 * with them, their memberships/subscriptions/api_keys (all ON DELETE
 * CASCADE from organizations — same as tests/helpers.ts's
 * deleteTestOrganization). Synthetic F19 test users
 * (*@test.ul-platform.invalid) are removed too. Does not touch anything
 * else in the database.
 */
async function main() {
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { like } = await import("drizzle-orm");

  try {
    const deletedOrgs = await db
      .delete(organizations)
      .where(like(organizations.name, "F19_TEST_ORG_%"))
      .returning({ id: organizations.id, name: organizations.name });
    const deletedUsers = await db
      .delete(users)
      .where(like(users.email, "f19-%@test.ul-platform.invalid"))
      .returning({ id: users.id });
    console.log(`Deleted ${deletedOrgs.length} F19 test organization(s), ${deletedUsers.length} F19 test user(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("F19 teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
