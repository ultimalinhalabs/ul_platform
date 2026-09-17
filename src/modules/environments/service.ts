import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicationEnvironments } from "../../db/schema/index.js";
import { getApplicationRecord } from "../applications/service.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolationError } from "../../shared/errors.js";

const ENVIRONMENT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertValidEnvironmentKey(key: string): void {
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
    throw new ValidationError('environment key must be lowercase alphanumeric/underscore (e.g. "production")');
  }
}

interface EnvironmentRow {
  id: string;
  applicationId: string;
  key: string;
  status: "ACTIVE" | "INACTIVE";
}

function shapeEnvironment(row: EnvironmentRow, applicationKey: string) {
  return { application: applicationKey, key: row.key, status: row.status };
}

/**
 * No HTTP route calls this yet — same posture as `role_permissions`
 * mutation and platform-level API keys: Environment is a platform
 * resource (CLAUDE.md's discovery prompt §29), and there is no
 * `PLATFORM_ADMIN` actor yet to safely gate a mutation endpoint behind
 * (see README "Who may manage platform applications?"). The function
 * exists, is audited, and is fully tested — ready to be wired to a
 * future Console-authenticated route without changing this layer.
 */
export async function createEnvironment(input: {
  applicationKey: string;
  key: string;
  actorUserId?: string;
}): Promise<ReturnType<typeof shapeEnvironment>> {
  assertValidEnvironmentKey(input.key);
  const application = await getApplicationRecord(input.applicationKey);

  let row: EnvironmentRow;
  try {
    const [inserted] = await db
      .insert(applicationEnvironments)
      .values({ applicationId: application.id, key: input.key })
      .returning();
    if (!inserted) throw new Error("Failed to create environment");
    row = inserted as EnvironmentRow;
  } catch (error) {
    if (isUniqueViolationError(error)) {
      throw new ConflictError(`Environment "${input.key}" already exists for ${input.applicationKey}`);
    }
    throw error;
  }

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: application.id,
    action: "environment.created",
    targetType: "application_environment",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey, key: input.key },
  });

  return shapeEnvironment(row, application.key);
}

export async function listEnvironmentsForApplication(applicationKey: string) {
  const application = await getApplicationRecord(applicationKey);
  const rows = await db
    .select({ id: applicationEnvironments.id, applicationId: applicationEnvironments.applicationId, key: applicationEnvironments.key, status: applicationEnvironments.status })
    .from(applicationEnvironments)
    .where(eq(applicationEnvironments.applicationId, application.id))
    .orderBy(applicationEnvironments.key);
  return rows.map((row) => shapeEnvironment(row as EnvironmentRow, application.key));
}

/** Tenant-safe by construction for the platform dimension: applicationId is always part of the WHERE, so one application's environment key can never resolve under a different application's key in the URL. */
export async function getEnvironmentDetail(applicationKey: string, environmentKey: string) {
  const application = await getApplicationRecord(applicationKey);
  const row = await getEnvironmentRecord(application.id, environmentKey);
  return shapeEnvironment(row, application.key);
}

/** Internal resolver used by modules/endpoints and modules/discovery — never exposed directly as an API shape. */
export async function getEnvironmentRecord(applicationId: string, environmentKey: string): Promise<EnvironmentRow> {
  const [row] = await db
    .select({ id: applicationEnvironments.id, applicationId: applicationEnvironments.applicationId, key: applicationEnvironments.key, status: applicationEnvironments.status })
    .from(applicationEnvironments)
    .where(and(eq(applicationEnvironments.applicationId, applicationId), eq(applicationEnvironments.key, environmentKey)))
    .limit(1);
  if (!row) throw new NotFoundError(`Unknown environment: ${environmentKey}`);
  return row as EnvironmentRow;
}

export async function updateEnvironmentStatus(input: {
  applicationKey: string;
  environmentKey: string;
  status: "ACTIVE" | "INACTIVE";
  actorUserId?: string;
}) {
  const application = await getApplicationRecord(input.applicationKey);
  const current = await getEnvironmentRecord(application.id, input.environmentKey);

  const [updated] = await db
    .update(applicationEnvironments)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(applicationEnvironments.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError(`Unknown environment: ${input.environmentKey}`);

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: application.id,
    action: "environment.updated",
    targetType: "application_environment",
    targetId: updated.id,
    metadata: { applicationKey: input.applicationKey, key: input.environmentKey, status: input.status },
  });

  return shapeEnvironment(updated as EnvironmentRow, application.key);
}
