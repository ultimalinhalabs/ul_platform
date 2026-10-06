import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicationRoles, applications, membershipApplicationRoles, memberships, roles } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { assertOwnerRoleChangeAllowed } from "../authorization/service.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";

async function getApplicationByKeyOrThrow(applicationKey: string) {
  const [application] = await db
    .select({ id: applications.id, key: applications.key })
    .from(applications)
    .where(eq(applications.key, applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${applicationKey}`);
  return application;
}

async function getMembershipInOrganizationOrThrow(organizationId: string, membershipId: string) {
  const [membership] = await db
    .select({ id: memberships.id, roleKey: roles.key })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  if (!membership) throw new NotFoundError("Membership not found");
  return membership;
}

/** The roles an application declares (its own catalog). */
export async function listApplicationRoles(applicationKey: string) {
  const application = await getApplicationByKeyOrThrow(applicationKey);
  return db
    .select({ key: applicationRoles.key, name: applicationRoles.name, description: applicationRoles.description })
    .from(applicationRoles)
    .where(eq(applicationRoles.applicationId, application.id))
    .orderBy(applicationRoles.key);
}

/**
 * Sets (or replaces) a membership's explicit role inside one application.
 * Tenant-safe: the membership must belong to `organizationId` (taken from
 * the already-authorized route context, never the body). The role must
 * exist in THAT application's catalog. Only an OWNER may grant or change
 * an application OWNER role — same rule as organization roles.
 */
export async function setMembershipApplicationRole(input: {
  organizationId: string;
  membershipId: string;
  applicationKey: string;
  roleKey: string;
  actorUserId: string;
  actorRoleKey: string;
}) {
  const application = await getApplicationByKeyOrThrow(input.applicationKey);
  await getMembershipInOrganizationOrThrow(input.organizationId, input.membershipId);

  const [catalogRole] = await db
    .select({ key: applicationRoles.key })
    .from(applicationRoles)
    .where(and(eq(applicationRoles.applicationId, application.id), eq(applicationRoles.key, input.roleKey)))
    .limit(1);
  if (!catalogRole) {
    throw new ValidationError(`Role ${input.roleKey} is not defined for application ${application.key}`);
  }

  const [current] = await db
    .select({ roleKey: membershipApplicationRoles.roleKey })
    .from(membershipApplicationRoles)
    .where(
      and(
        eq(membershipApplicationRoles.membershipId, input.membershipId),
        eq(membershipApplicationRoles.applicationId, application.id),
      ),
    )
    .limit(1);
  assertOwnerRoleChangeAllowed(input.actorRoleKey, [current?.roleKey, input.roleKey]);

  const [row] = await db
    .insert(membershipApplicationRoles)
    .values({ membershipId: input.membershipId, applicationId: application.id, roleKey: input.roleKey })
    .onConflictDoUpdate({
      target: [membershipApplicationRoles.membershipId, membershipApplicationRoles.applicationId],
      set: { roleKey: input.roleKey, updatedAt: new Date() },
    })
    .returning();

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: application.id,
    action: "membership.application_role.set",
    targetType: "membership",
    targetId: input.membershipId,
    metadata: { applicationKey: application.key, roleKey: input.roleKey, previousRoleKey: current?.roleKey ?? null },
  });

  return { membershipId: row!.membershipId, applicationKey: application.key, roleKey: row!.roleKey };
}

/** Removes the explicit application role; the membership falls back to the documented mapping. */
export async function removeMembershipApplicationRole(input: {
  organizationId: string;
  membershipId: string;
  applicationKey: string;
  actorUserId: string;
  actorRoleKey: string;
}) {
  const application = await getApplicationByKeyOrThrow(input.applicationKey);
  await getMembershipInOrganizationOrThrow(input.organizationId, input.membershipId);

  const [current] = await db
    .select({ roleKey: membershipApplicationRoles.roleKey })
    .from(membershipApplicationRoles)
    .where(
      and(
        eq(membershipApplicationRoles.membershipId, input.membershipId),
        eq(membershipApplicationRoles.applicationId, application.id),
      ),
    )
    .limit(1);
  if (!current) throw new NotFoundError("No explicit application role for this membership");
  assertOwnerRoleChangeAllowed(input.actorRoleKey, [current.roleKey]);

  await db
    .delete(membershipApplicationRoles)
    .where(
      and(
        eq(membershipApplicationRoles.membershipId, input.membershipId),
        eq(membershipApplicationRoles.applicationId, application.id),
      ),
    );

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: application.id,
    action: "membership.application_role.removed",
    targetType: "membership",
    targetId: input.membershipId,
    metadata: { applicationKey: application.key, previousRoleKey: current.roleKey },
  });
}

/** Explicit application roles for a set of memberships: membershipId → applicationKey → roleKey. */
export async function getExplicitApplicationRoles(membershipIds: string[]) {
  const result = new Map<string, Map<string, string>>();
  if (membershipIds.length === 0) return result;
  const rows = await db
    .select({
      membershipId: membershipApplicationRoles.membershipId,
      applicationKey: applications.key,
      roleKey: membershipApplicationRoles.roleKey,
    })
    .from(membershipApplicationRoles)
    .innerJoin(applications, eq(applications.id, membershipApplicationRoles.applicationId))
    .where(inArray(membershipApplicationRoles.membershipId, membershipIds));
  for (const row of rows) {
    if (!result.has(row.membershipId)) result.set(row.membershipId, new Map());
    result.get(row.membershipId)!.set(row.applicationKey, row.roleKey);
  }
  return result;
}
