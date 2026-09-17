import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicationEndpoints } from "../../db/schema/index.js";
import { getApplicationRecord } from "../applications/service.js";
import { recordAuditEvent } from "../audit/service.js";
import { getEnvironmentRecord } from "../environments/service.js";
import { ConflictError, NotFoundError, isUniqueViolationError } from "../../shared/errors.js";
import { validateEndpointUrl } from "./validation.js";

export type EndpointType = "API";

interface EndpointRow {
  id: string;
  environmentId: string;
  type: EndpointType;
  baseUrl: string;
  status: "ACTIVE" | "INACTIVE";
}

function shapeEndpoint(row: EndpointRow) {
  return { type: row.type, baseUrl: row.baseUrl, status: row.status };
}

/**
 * No HTTP route calls this yet — see modules/environments/service.ts for
 * why (platform resource, no PLATFORM_ADMIN actor to gate it behind).
 */
export async function createEndpoint(input: {
  applicationKey: string;
  environmentKey: string;
  type: EndpointType;
  baseUrl: string;
  actorUserId?: string;
}): Promise<ReturnType<typeof shapeEndpoint>> {
  const application = await getApplicationRecord(input.applicationKey);
  const environment = await getEnvironmentRecord(application.id, input.environmentKey);
  validateEndpointUrl(input.baseUrl, input.environmentKey);

  let row: EndpointRow;
  try {
    const [inserted] = await db
      .insert(applicationEndpoints)
      .values({ environmentId: environment.id, type: input.type, baseUrl: input.baseUrl })
      .returning();
    if (!inserted) throw new Error("Failed to create endpoint");
    row = inserted as EndpointRow;
  } catch (error) {
    if (isUniqueViolationError(error)) {
      throw new ConflictError(`A "${input.type}" endpoint already exists for ${input.applicationKey}/${input.environmentKey}`);
    }
    throw error;
  }

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: application.id,
    action: "endpoint.created",
    targetType: "application_endpoint",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey, environmentKey: input.environmentKey, type: input.type },
  });

  return shapeEndpoint(row);
}

export async function listEndpointsForEnvironment(applicationKey: string, environmentKey: string) {
  const application = await getApplicationRecord(applicationKey);
  const environment = await getEnvironmentRecord(application.id, environmentKey);
  const rows = await db
    .select({ id: applicationEndpoints.id, environmentId: applicationEndpoints.environmentId, type: applicationEndpoints.type, baseUrl: applicationEndpoints.baseUrl, status: applicationEndpoints.status })
    .from(applicationEndpoints)
    .where(eq(applicationEndpoints.environmentId, environment.id))
    .orderBy(applicationEndpoints.type);
  return rows.map((row) => shapeEndpoint(row as EndpointRow));
}

/** Internal resolver used by modules/discovery — never exposed directly as an API shape. */
export async function getEndpointRecord(environmentId: string, type: EndpointType): Promise<EndpointRow> {
  const [row] = await db
    .select({ id: applicationEndpoints.id, environmentId: applicationEndpoints.environmentId, type: applicationEndpoints.type, baseUrl: applicationEndpoints.baseUrl, status: applicationEndpoints.status })
    .from(applicationEndpoints)
    .where(and(eq(applicationEndpoints.environmentId, environmentId), eq(applicationEndpoints.type, type)))
    .limit(1);
  if (!row) throw new NotFoundError(`No "${type}" endpoint configured for this environment`);
  return row as EndpointRow;
}

export async function updateEndpointStatus(input: {
  applicationKey: string;
  environmentKey: string;
  type: EndpointType;
  status: "ACTIVE" | "INACTIVE";
  actorUserId?: string;
}) {
  const application = await getApplicationRecord(input.applicationKey);
  const environment = await getEnvironmentRecord(application.id, input.environmentKey);
  const current = await getEndpointRecord(environment.id, input.type);

  const [updated] = await db
    .update(applicationEndpoints)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(applicationEndpoints.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError("Endpoint not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: application.id,
    action: "endpoint.updated",
    targetType: "application_endpoint",
    targetId: updated.id,
    metadata: { applicationKey: input.applicationKey, environmentKey: input.environmentKey, type: input.type, status: input.status },
  });

  return shapeEndpoint(updated as EndpointRow);
}
