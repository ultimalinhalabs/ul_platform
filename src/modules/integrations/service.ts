import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicationIntegrations, applications } from "../../db/schema/index.js";
import { getApplicationRecord } from "../applications/service.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolationError } from "../../shared/errors.js";

interface IntegrationRow {
  id: string;
  sourceApplicationId: string;
  targetApplicationId: string;
  status: "ACTIVE" | "INACTIVE";
  description: string | null;
}

function shapeIntegration(row: IntegrationRow, sourceKey: string, targetKey: string) {
  return { source: sourceKey, target: targetKey, status: row.status, description: row.description };
}

/**
 * No HTTP route calls this yet — see modules/environments/service.ts for
 * why (platform resource, no PLATFORM_ADMIN actor to gate it behind).
 * Directional and one-way only: creating QUALE_A_DICA→NA_PISTA never
 * implies NA_PISTA→QUALE_A_DICA — that would need its own row.
 */
export async function createIntegration(input: {
  sourceApplicationKey: string;
  targetApplicationKey: string;
  description?: string;
  actorUserId?: string;
}): Promise<ReturnType<typeof shapeIntegration>> {
  if (input.sourceApplicationKey === input.targetApplicationKey) {
    throw new ValidationError("An application cannot be integrated with itself");
  }

  const source = await getApplicationRecord(input.sourceApplicationKey);
  const target = await getApplicationRecord(input.targetApplicationKey);

  let row: IntegrationRow;
  try {
    const [inserted] = await db
      .insert(applicationIntegrations)
      .values({
        sourceApplicationId: source.id,
        targetApplicationId: target.id,
        description: input.description,
      })
      .returning();
    if (!inserted) throw new Error("Failed to create integration");
    row = inserted as IntegrationRow;
  } catch (error) {
    if (isUniqueViolationError(error)) {
      throw new ConflictError(
        `Integration "${input.sourceApplicationKey}" → "${input.targetApplicationKey}" already exists`,
      );
    }
    throw error;
  }

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: source.id,
    action: "integration.created",
    targetType: "application_integration",
    targetId: row.id,
    metadata: { sourceApplicationKey: input.sourceApplicationKey, targetApplicationKey: input.targetApplicationKey },
  });

  return shapeIntegration(row, source.key, target.key);
}

export async function listIntegrationsForSource(sourceApplicationKey: string) {
  const source = await getApplicationRecord(sourceApplicationKey);
  const rows = await db
    .select({
      id: applicationIntegrations.id,
      sourceApplicationId: applicationIntegrations.sourceApplicationId,
      targetApplicationId: applicationIntegrations.targetApplicationId,
      status: applicationIntegrations.status,
      description: applicationIntegrations.description,
      targetKey: applications.key,
    })
    .from(applicationIntegrations)
    .innerJoin(applications, eq(applications.id, applicationIntegrations.targetApplicationId))
    .where(eq(applicationIntegrations.sourceApplicationId, source.id))
    .orderBy(applications.key);

  return rows.map((row) => shapeIntegration(row as IntegrationRow, source.key, row.targetKey));
}

/** Tenant-safe by construction for the platform dimension: sourceApplicationId is always part of the WHERE. */
export async function getIntegrationDetail(sourceApplicationKey: string, targetApplicationKey: string) {
  const source = await getApplicationRecord(sourceApplicationKey);
  const target = await getApplicationRecord(targetApplicationKey);
  const row = await getIntegrationRecord(source.id, target.id);
  return shapeIntegration(row, source.key, target.key);
}

/** Internal resolver used by modules/discovery — never exposed directly as an API shape. */
export async function getIntegrationRecord(
  sourceApplicationId: string,
  targetApplicationId: string,
): Promise<IntegrationRow> {
  const [row] = await db
    .select({
      id: applicationIntegrations.id,
      sourceApplicationId: applicationIntegrations.sourceApplicationId,
      targetApplicationId: applicationIntegrations.targetApplicationId,
      status: applicationIntegrations.status,
      description: applicationIntegrations.description,
    })
    .from(applicationIntegrations)
    .where(
      and(
        eq(applicationIntegrations.sourceApplicationId, sourceApplicationId),
        eq(applicationIntegrations.targetApplicationId, targetApplicationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("No such integration is registered");
  return row as IntegrationRow;
}

export async function updateIntegrationStatus(input: {
  sourceApplicationKey: string;
  targetApplicationKey: string;
  status?: "ACTIVE" | "INACTIVE";
  description?: string;
  actorUserId?: string;
}) {
  const source = await getApplicationRecord(input.sourceApplicationKey);
  const target = await getApplicationRecord(input.targetApplicationKey);
  const current = await getIntegrationRecord(source.id, target.id);

  const [updated] = await db
    .update(applicationIntegrations)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(applicationIntegrations.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError("No such integration is registered");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: source.id,
    action: "integration.updated",
    targetType: "application_integration",
    targetId: updated.id,
    metadata: {
      sourceApplicationKey: input.sourceApplicationKey,
      targetApplicationKey: input.targetApplicationKey,
      status: input.status,
      description: input.description,
    },
  });

  return shapeIntegration(updated as IntegrationRow, source.key, target.key);
}
