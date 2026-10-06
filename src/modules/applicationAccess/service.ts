import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, organizationApplicationAccess, organizations } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

/**
 * Fase 6 — Organization → Application ACCESS, separate from billing.
 * Effective access = an `active` row in `organization_application_access`,
 * nothing else: a subscription neither grants nor is required for access
 * (the commercial layer — subscriptions/plans/entitlements — is Fase 7).
 */

async function resolveOrganizationAndApplication(organizationId: string, applicationKey: string) {
  const [organization] = await db
    .select({ id: organizations.id, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new NotFoundError("Organization not found");
  const [application] = await db
    .select({ id: applications.id, key: applications.key, status: applications.status })
    .from(applications)
    .where(eq(applications.key, applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${applicationKey}`);
  return { organizationId: organization.id, organizationStatus: organization.status, application };
}

/** Idempotent: grants (or re-activates) access. Platform-admin operation. */
export async function grantApplicationAccess(input: { organizationId: string; applicationKey: string; actorUserId: string }) {
  const { organizationId, organizationStatus, application } = await resolveOrganizationAndApplication(
    input.organizationId,
    input.applicationKey,
  );
  if (organizationStatus !== "active") throw new ConflictError("Cannot grant application access to a suspended organization");
  if (application.status !== "ACTIVE") throw new ConflictError(`Application ${application.key} is not active`);
  const [row] = await db
    .insert(organizationApplicationAccess)
    .values({ organizationId, applicationId: application.id, status: "active", grantedBy: input.actorUserId })
    .onConflictDoUpdate({
      target: [organizationApplicationAccess.organizationId, organizationApplicationAccess.applicationId],
      set: { status: "active", grantedBy: input.actorUserId, revokedAt: null, updatedAt: sql`now()` },
    })
    .returning();
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId,
    applicationId: application.id,
    action: "organization.application_access.granted",
    targetType: "organization",
    targetId: organizationId,
    metadata: { applicationKey: application.key },
  });
  return { organizationId, applicationKey: application.key, status: row!.status };
}

/** Revocation is a status change, never a delete. */
export async function revokeApplicationAccess(input: { organizationId: string; applicationKey: string; actorUserId: string }) {
  const { organizationId, application } = await resolveOrganizationAndApplication(input.organizationId, input.applicationKey);
  const [row] = await db
    .update(organizationApplicationAccess)
    .set({ status: "revoked", revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(organizationApplicationAccess.organizationId, organizationId),
        eq(organizationApplicationAccess.applicationId, application.id),
        eq(organizationApplicationAccess.status, "active"),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("No active access to revoke");
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId,
    applicationId: application.id,
    action: "organization.application_access.revoked",
    targetType: "organization",
    targetId: organizationId,
    metadata: { applicationKey: application.key },
  });
  return { organizationId, applicationKey: application.key, status: row.status };
}

export async function listApplicationAccessForOrganization(organizationId: string) {
  return db
    .select({
      applicationKey: applications.key,
      applicationName: applications.name,
      status: organizationApplicationAccess.status,
      grantedAt: organizationApplicationAccess.createdAt,
      revokedAt: organizationApplicationAccess.revokedAt,
    })
    .from(organizationApplicationAccess)
    .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
    .where(eq(organizationApplicationAccess.organizationId, organizationId))
    .orderBy(applications.key);
}

/** Active application keys per organization: organizationId → applicationKey[] (ACTIVE applications only). */
export async function getActiveApplicationKeys(organizationIds: string[]) {
  const result = new Map<string, string[]>();
  if (organizationIds.length === 0) return result;
  const rows = await db
    .select({ organizationId: organizationApplicationAccess.organizationId, applicationKey: applications.key })
    .from(organizationApplicationAccess)
    .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
    .where(
      and(
        inArray(organizationApplicationAccess.organizationId, organizationIds),
        eq(organizationApplicationAccess.status, "active"),
        eq(applications.status, "ACTIVE"),
      ),
    );
  for (const row of rows) {
    if (!result.has(row.organizationId)) result.set(row.organizationId, []);
    result.get(row.organizationId)!.push(row.applicationKey);
  }
  return result;
}
