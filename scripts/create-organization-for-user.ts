import "dotenv/config";

/**
 * Manually-run helper for dev/test accounts: gives an EXISTING platform user
 * an organization they own. Reuses createOrganization(), so the new
 * organization, the OWNER membership and the audit event are written in the
 * same transaction exactly as POST /v1/organizations would.
 *
 * Never creates a Supabase or platform user — the account must already have
 * authenticated with UL Platform once (so its `users` row exists). Refuses
 * if the user already belongs to an organization, so re-running is harmless.
 *
 * Usage:
 *   ORG_OWNER_EMAIL=someone@example.com [ORG_NAME="Some Org"] \
 *     npm run dev:create-organization
 */
async function main() {
  const email = process.env.ORG_OWNER_EMAIL;
  if (!email) {
    console.error("ORG_OWNER_EMAIL is not set. See scripts/create-organization-for-user.ts for usage.");
    process.exit(1);
  }
  const organizationName = process.env.ORG_NAME ?? "Test Organization";

  const { db, queryClient } = await import("../src/db/index.js");
  const { memberships, users } = await import("../src/db/schema/index.js");
  const { createOrganization } = await import("../src/modules/organizations/service.js");
  const { eq } = await import("drizzle-orm");

  try {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      throw new Error(
        `No platform user with email ${email}. Sign in to UL Platform with that account at least once first.`,
      );
    }

    const [existing] = await db
      .select({ organizationId: memberships.organizationId })
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .limit(1);
    if (existing) {
      console.log(`User ${user.id} already has a membership (organization ${existing.organizationId}) — nothing to do.`);
      return;
    }

    const organization = await createOrganization({ name: organizationName, createdBy: user.id });
    console.log(`Created organization "${organization.name}" (${organization.id}); user ${user.id} is its OWNER.`);
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("Failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
