import "dotenv/config";

/**
 * One-time, manually-run bootstrap of the platform's first PLATFORM_ADMIN.
 * See modules/platformAdmins/bootstrap.ts for the safety rules this
 * enforces (idempotent, refuses once any other admin exists, never creates
 * a user, never touches Supabase, never logs a secret).
 *
 * Usage:
 *   1. Sign in to UL Platform at least once with the target Supabase
 *      account, so its `users` row exists.
 *   2. Set the PLATFORM_ADMIN_BOOTSTRAP_USER_ID environment variable to
 *      that account's Supabase user id (a UUID — not an email, not a
 *      secret, safe to pass on the command line).
 *   3. Run: npm run platform:bootstrap-admin
 *   4. To grant a second/third admin afterwards, do NOT re-run this
 *      script — have the newly-bootstrapped admin call
 *      POST /v1/platform/admins instead.
 */
async function main() {
  const targetUserId = process.env.PLATFORM_ADMIN_BOOTSTRAP_USER_ID;
  if (!targetUserId) {
    console.error("PLATFORM_ADMIN_BOOTSTRAP_USER_ID is not set. See scripts/bootstrap-platform-admin.ts for usage.");
    process.exit(1);
  }

  const { bootstrapFirstPlatformAdmin } = await import("../src/modules/platformAdmins/bootstrap.js");
  const { queryClient } = await import("../src/db/index.js");

  try {
    const result = await bootstrapFirstPlatformAdmin(targetUserId);
    if (result.outcome === "created") {
      console.log(`Platform admin bootstrapped for user ${result.userId}.`);
    } else {
      console.log(`User ${result.userId} is already the platform's active administrator — nothing to do.`);
    }
  } finally {
    await queryClient.end();
  }
}

main().catch((error) => {
  console.error("Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
