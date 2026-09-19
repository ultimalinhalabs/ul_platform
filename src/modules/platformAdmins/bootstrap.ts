import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformMemberships, users } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getPlatformRoleByKey } from "../platformRoles/service.js";

/**
 * One-time controlled bootstrap of the platform's very first PLATFORM_ADMIN
 * (CLAUDE.md's Phase 13 brief §"BOOTSTRAP DO PRIMEIRO PLATFORM ADMIN").
 *
 * Deliberately NOT reachable over HTTP: at the moment this needs to run,
 * no authenticated actor holds platform authority yet, so an HTTP endpoint
 * for it would have to be either unauthenticated (a standing privilege-
 * escalation backdoor anyone could hit) or gated behind an existing admin
 * (impossible — that's the chicken-and-egg this function exists to break).
 * It is only ever invoked from scripts/bootstrap-platform-admin.ts, run
 * manually by whoever already holds DATABASE_URL access — the same trust
 * boundary `npm run db:seed`/`db:migrate` already operate under, not a new
 * one. See README "Platform Control Plane" for the operational runbook.
 *
 * Refuses once ANY active administrator already exists (unless it's the
 * exact same target, making a re-run idempotent) — this keeps bootstrap a
 * one-time event rather than a standing side-channel for adding a SECOND
 * admin that bypasses `platform.platform_admin.manage` authorization
 * entirely. Every subsequent admin must be granted through
 * `POST /v1/platform/admins` by an admin this function already created.
 */
export async function bootstrapFirstPlatformAdmin(
  targetUserId: string,
): Promise<{ outcome: "created" | "already-bootstrapped"; userId: string }> {
  const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!targetUser) {
    throw new Error(
      `No platform user found for id ${targetUserId}. The target must have authenticated with UL Platform ` +
        "(via Supabase Auth) at least once — this never creates a Supabase or platform user.",
    );
  }

  const [anyActiveAdmin] = await db
    .select({ userId: platformMemberships.userId })
    .from(platformMemberships)
    .where(eq(platformMemberships.status, "ACTIVE"))
    .limit(1);

  if (anyActiveAdmin) {
    if (anyActiveAdmin.userId === targetUserId) {
      return { outcome: "already-bootstrapped", userId: targetUserId };
    }
    throw new Error(
      "The platform already has an active administrator. Bootstrap only ever creates the FIRST admin — " +
        "have that existing admin call POST /v1/platform/admins to grant access to additional users.",
    );
  }

  const role = await getPlatformRoleByKey("PLATFORM_ADMIN");

  await db
    .insert(platformMemberships)
    .values({ userId: targetUserId, platformRoleId: role.id })
    .onConflictDoUpdate({
      target: platformMemberships.userId,
      set: { platformRoleId: role.id, status: "ACTIVE", updatedAt: new Date() },
    });

  await recordAuditEvent({
    action: "platform.admin.created",
    targetType: "platform_membership",
    targetId: targetUserId,
    metadata: { targetUserId, platformRoleKey: role.key, source: "bootstrap-script" },
  });

  return { outcome: "created", userId: targetUserId };
}
