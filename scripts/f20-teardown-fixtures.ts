import "dotenv/config";

/** Removes every F20 test organization/user — same pattern as f19-teardown-fixtures.ts. */
async function main() {
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, users } = await import("../src/db/schema/index.js");
  const { like } = await import("drizzle-orm");

  try {
    const deletedOrgs = await db.delete(organizations).where(like(organizations.name, "F20_TEST_ORG_%")).returning({ id: organizations.id });
    const deletedUsers = await db.delete(users).where(like(users.email, "f20-%@test.ul-platform.invalid")).returning({ id: users.id });
    console.log(`Deleted ${deletedOrgs.length} F20 test organization(s), ${deletedUsers.length} F20 test user(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("F20 teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
