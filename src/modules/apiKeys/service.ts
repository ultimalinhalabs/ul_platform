import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiKeys, applications } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError, UnauthorizedError } from "../../shared/errors.js";
import {
  buildApiKeyToken,
  generateApiKeySecret,
  hashApiKeySecret,
  parseApiKeyToken,
  secretMatchesHash,
} from "./crypto.js";

interface MetadataRow {
  id: string;
  organizationId: string | null;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  applicationKey: string;
}

/** Never includes secretHash or any cryptographic material — see README "API Keys". */
function shapeMetadata(row: MetadataRow) {
  return {
    id: row.id,
    application: row.applicationKey,
    organizationId: row.organizationId,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Creates an Organization-scoped API key. Platform-level (organizationId
 * = null) credentials are schema-supported but deliberately not
 * creatable through this function/API — see apiKeys.ts schema comment
 * and README: no PLATFORM_ADMIN actor exists yet to safely authorize
 * that over HTTP, so it's documented as a controlled future operation
 * (direct DB/seed) rather than improvised as an org-permission escape hatch.
 */
export async function createOrganizationApiKey(input: {
  organizationId: string;
  applicationKey: string;
  actorUserId: string;
  expiresAt?: Date;
}) {
  const [application] = await db
    .select({ id: applications.id, key: applications.key })
    .from(applications)
    .where(eq(applications.key, input.applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${input.applicationKey}`);

  const secret = generateApiKeySecret();
  const secretHash = hashApiKeySecret(secret);

  const [row] = await db
    .insert(apiKeys)
    .values({
      secretHash,
      applicationId: application.id,
      organizationId: input.organizationId,
      createdByUserId: input.actorUserId,
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error("Failed to create API key");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: application.id,
    action: "api_key.created",
    targetType: "api_key",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey },
  });

  return {
    ...shapeMetadata({ ...row, applicationKey: application.key }),
    // shown exactly once — never persisted, never logged, never re-derivable
    secret: buildApiKeyToken(row.id, secret),
  };
}

export async function listApiKeysForOrganization(organizationId: string) {
  const rows = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      applicationKey: applications.key,
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .where(eq(apiKeys.organizationId, organizationId))
    .orderBy(apiKeys.createdAt);

  return rows.map(shapeMetadata);
}

/** Tenant-safe by construction: organizationId is always part of the WHERE, never checked after the fact. */
export async function getApiKeyDetail(organizationId: string, keyId: string) {
  const [row] = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      applicationKey: applications.key,
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new NotFoundError("API key not found");
  return shapeMetadata(row);
}

export async function revokeApiKey(input: { organizationId: string; keyId: string; actorUserId: string }) {
  const [current] = await db
    .select({ id: apiKeys.id, status: apiKeys.status, applicationId: apiKeys.applicationId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.organizationId, input.organizationId)))
    .limit(1);
  if (!current) throw new NotFoundError("API key not found");
  if (current.status === "REVOKED") throw new ConflictError("API key is already revoked");

  const [updated] = await db
    .update(apiKeys)
    .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(apiKeys.id, input.keyId))
    .returning();
  if (!updated) throw new NotFoundError("API key not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: current.applicationId,
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: input.keyId,
  });

  const [application] = await db
    .select({ key: applications.key })
    .from(applications)
    .where(eq(applications.id, current.applicationId));

  return shapeMetadata({ ...updated, applicationKey: application!.key });
}

export interface VerifiedServiceCredential {
  apiKeyId: string;
  applicationId: string;
  applicationKey: string;
  organizationId: string | null;
}

/**
 * Verifies a presented `ulk_<id>.<secret>` token. Every failure —
 * malformed, unknown id, wrong secret, revoked, expired, or the owning
 * Application not ACTIVE — throws the same UnauthorizedError with the
 * same generic message, so no response ever reveals which case occurred
 * (see README "API Keys" security section).
 */
export async function verifyApiKeyToken(token: string): Promise<VerifiedServiceCredential> {
  const parsed = parseApiKeyToken(token);
  if (!parsed) throw new UnauthorizedError("Invalid API key");

  const [row] = await db
    .select({
      id: apiKeys.id,
      secretHash: apiKeys.secretHash,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      organizationId: apiKeys.organizationId,
      applicationId: apiKeys.applicationId,
      applicationKey: applications.key,
      applicationStatus: applications.status,
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .where(eq(apiKeys.id, parsed.id))
    .limit(1);

  if (!row) throw new UnauthorizedError("Invalid API key");
  if (!secretMatchesHash(parsed.secret, row.secretHash)) throw new UnauthorizedError("Invalid API key");
  if (row.status !== "ACTIVE") throw new UnauthorizedError("Invalid API key");
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError("Invalid API key");
  if (row.applicationStatus !== "ACTIVE") throw new UnauthorizedError("Invalid API key");

  return {
    apiKeyId: row.id,
    applicationId: row.applicationId,
    applicationKey: row.applicationKey,
    organizationId: row.organizationId,
  };
}
