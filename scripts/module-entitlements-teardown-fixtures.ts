import "dotenv/config";
import { assertLocalOnlyTargets } from "./localOnlyGuard.js";

// Dev-only: refuses to run unless every target is local (see localOnlyGuard.ts).
assertLocalOnlyTargets({ database: true });

/** Removes the module-entitlement E2E organizations, users and the two TEST_MOD_* plans (same pattern as f19–f27). */
async function main() {
  const { db, queryClient } = await import("../src/db/index.js");
  const { organizations, plans, users } = await import("../src/db/schema/index.js");
  const { like } = await import("drizzle-orm");

  try {
    const deletedOrgs = await db.delete(organizations).where(like(organizations.name, "MODENT_TEST_ORG_%")).returning({ id: organizations.id });
    const deletedUsers = await db.delete(users).where(like(users.email, "modent-%@test.ul-platform.invalid")).returning({ id: users.id });
    const deletedPlans = await db.delete(plans).where(like(plans.key, "TEST_MOD_%")).returning({ id: plans.id });
    console.log(`Deleted ${deletedOrgs.length} organization(s), ${deletedUsers.length} user(s), ${deletedPlans.length} plan(s).`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("Module-entitlement teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
