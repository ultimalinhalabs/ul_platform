import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiKeyScopes, apiKeys, applications, serviceScopes, type CredentialClass } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { AppError, ApplicationAccessRequiredError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "../../shared/errors.js";
import { getActiveApplicationKeys } from "../applicationAccess/service.js";
import { getGrantedScopeKeys, validateRequestedScopes } from "../serviceScopes/service.js";
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
function shapeMetadata(row: MetadataRow, scopes: string[]) {
  return {
    id: row.id,
    application: row.applicationKey,
    organizationId: row.organizationId,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    scopes,
  };
}

/** Batched — one query for every key's granted scopes instead of N+1 per listed key. */
async function getGrantedScopeKeysByApiKeyId(apiKeyIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (apiKeyIds.length === 0) return map;

  const rows = await db
    .select({ apiKeyId: apiKeyScopes.apiKeyId, key: serviceScopes.key })
    .from(apiKeyScopes)
    .innerJoin(serviceScopes, eq(serviceScopes.id, apiKeyScopes.serviceScopeId))
    .where(inArray(apiKeyScopes.apiKeyId, apiKeyIds));

  for (const row of rows) {
    const existing = map.get(row.apiKeyId);
    if (existing) existing.push(row.key);
    else map.set(row.apiKeyId, [row.key]);
  }
  return map;
}

/** D2-B — the provisioner scope is never grantable to anything but a PLATFORM_SERVICE/PROVISIONER credential. */
export const PROVISIONER_SCOPE = "credential.provision";
export const PROVISIONER_PURPOSE = "PROVISIONER";
/** D2-B — how long an issued INTEGRATION_MANAGED credential may stay PENDING (computed at use time, no worker). */
export const PENDING_CREDENTIAL_WINDOW_MS = 10 * 60_000;

/**
 * Creates an Organization-scoped API key (class ORGANIZATION). Platform-level
 * credentials are created by createPlatformApiKey (PLATFORM_ADMIN only);
 * INTEGRATION_MANAGED credentials only by the provisioning service.
 */
export async function createOrganizationApiKey(input: {
  organizationId: string;
  applicationKey: string;
  actorUserId: string;
  expiresAt?: Date;
  scopes?: string[];
}) {
  const [application] = await db
    .select({ id: applications.id, key: applications.key })
    .from(applications)
    .where(eq(applications.key, input.applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${input.applicationKey}`);

  // Block 1D (G6) — being an OWNER is not enough: an organization credential for an application exists only while
  // the organization has EFFECTIVE access to it (active, application active, not ended with its contractual grant).
  // Existing keys are untouched; only creation is gated.
  const access = await getActiveApplicationKeys([input.organizationId]);
  if (!(access.get(input.organizationId) ?? []).includes(application.key)) {
    throw new ApplicationAccessRequiredError(`The organization has no active access to ${application.key}`);
  }

  if ((input.scopes ?? []).includes(PROVISIONER_SCOPE)) {
    throw new ValidationError(`Scope ${PROVISIONER_SCOPE} is reserved for the platform provisioner credential`);
  }

  // Every requested scope is checked against the registry AND this
  // application's allowlist before anything is persisted — a client can
  // never mint a credential with a scope it merely typed (see
  // modules/serviceScopes/service.ts).
  const resolvedScopes = await validateRequestedScopes(
    application.id,
    application.key,
    input.scopes ?? [],
  );

  const secret = generateApiKeySecret();
  const secretHash = hashApiKeySecret(secret);

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        secretHash,
        applicationId: application.id,
        organizationId: input.organizationId,
        credentialClass: "ORGANIZATION",
        createdByUserId: input.actorUserId,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!created) throw new Error("Failed to create API key");

    if (resolvedScopes.length > 0) {
      await tx
        .insert(apiKeyScopes)
        .values(resolvedScopes.map((s) => ({ apiKeyId: created.id, serviceScopeId: s.id })));
    }

    return created;
  });

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    applicationId: application.id,
    action: "api_key.created",
    targetType: "api_key",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey, scopes: resolvedScopes.map((s) => s.key) },
  });

  return {
    ...shapeMetadata({ ...row, applicationKey: application.key }, resolvedScopes.map((s) => s.key)),
    // shown exactly once — never persisted, never logged, never re-derivable
    secret: buildApiKeyToken(row.id, secret),
  };
}

/**
 * Creates a platform-level (organizationId = null) API key — "the NA_PISTA
 * backend itself" rather than any one Organization's integration with it.
 * Schema-anticipated since Phase 12 (see db/schema/apiKeys.ts's comment)
 * but never reachable over HTTP until now: this is exactly the "controlled
 * future provisioning path" that comment describes, gated behind
 * `platform.credential.manage` rather than any Organization permission —
 * see routes/v1/platform.ts. Otherwise identical to
 * `createOrganizationApiKey`: same secret generation, same scope
 * validation, same shown-once contract.
 */
export async function createPlatformApiKey(input: {
  applicationKey: string;
  actorUserId: string;
  expiresAt?: Date;
  scopes?: string[];
  /** D2-B — `PROVISIONER`: the product's reconciler credential; its only scope is `credential.provision`. */
  purpose?: typeof PROVISIONER_PURPOSE;
}) {
  const [application] = await db
    .select({ id: applications.id, key: applications.key })
    .from(applications)
    .where(eq(applications.key, input.applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${input.applicationKey}`);

  const requested = input.scopes ?? [];
  if (input.purpose === PROVISIONER_PURPOSE) {
    if (requested.length !== 1 || requested[0] !== PROVISIONER_SCOPE) {
      throw new ValidationError(`A ${PROVISIONER_PURPOSE} credential has exactly one scope: ${PROVISIONER_SCOPE}`);
    }
  } else if (requested.includes(PROVISIONER_SCOPE)) {
    throw new ValidationError(`Scope ${PROVISIONER_SCOPE} requires purpose ${PROVISIONER_PURPOSE}`);
  }
  const resolvedScopes = await validateRequestedScopes(application.id, application.key, requested);

  const secret = generateApiKeySecret();
  const secretHash = hashApiKeySecret(secret);

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiKeys)
      .values({
        secretHash,
        applicationId: application.id,
        organizationId: null,
        credentialClass: "PLATFORM_SERVICE",
        purpose: input.purpose ?? null,
        createdByUserId: input.actorUserId,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!created) throw new Error("Failed to create platform API key");

    if (resolvedScopes.length > 0) {
      await tx.insert(apiKeyScopes).values(resolvedScopes.map((s) => ({ apiKeyId: created.id, serviceScopeId: s.id })));
    }

    return created;
  });

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: application.id,
    action: "platform.credential.created",
    targetType: "api_key",
    targetId: row.id,
    metadata: { applicationKey: input.applicationKey, scopes: resolvedScopes.map((s) => s.key), purpose: row.purpose },
  });

  return {
    ...shapeMetadata({ ...row, applicationKey: application.key }, resolvedScopes.map((s) => s.key)),
    purpose: row.purpose,
    // shown exactly once — never persisted, never logged, never re-derivable
    secret: buildApiKeyToken(row.id, secret),
  };
}

/** Every platform-level credential — class PLATFORM_SERVICE, never a tenant's. */
export async function listPlatformApiKeys() {
  const rows = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      applicationKey: applications.key,
      purpose: apiKeys.purpose,
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .where(eq(apiKeys.credentialClass, "PLATFORM_SERVICE"))
    .orderBy(apiKeys.createdAt);

  const scopesByKeyId = await getGrantedScopeKeysByApiKeyId(rows.map((r) => r.id));
  return rows.map((row) => ({ ...shapeMetadata(row, scopesByKeyId.get(row.id) ?? []), purpose: row.purpose }));
}

/** Tenant-safe in the other direction: class PLATFORM_SERVICE is always part of the WHERE, so this can never touch an Organization's own key nor a managed one. */
export async function revokePlatformApiKey(input: { keyId: string; actorUserId: string }) {
  const [current] = await db
    .select({ id: apiKeys.id, status: apiKeys.status, applicationId: apiKeys.applicationId })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.credentialClass, "PLATFORM_SERVICE")))
    .limit(1);
  if (!current) throw new NotFoundError("Platform API key not found");
  if (current.status === "REVOKED") throw new ConflictError("API key is already revoked");

  const [updated] = await db
    .update(apiKeys)
    .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(apiKeys.id, input.keyId))
    .returning();
  if (!updated) throw new NotFoundError("Platform API key not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    applicationId: current.applicationId,
    action: "platform.credential.revoked",
    targetType: "api_key",
    targetId: input.keyId,
  });

  const [application] = await db
    .select({ key: applications.key })
    .from(applications)
    .where(eq(applications.id, current.applicationId));

  return shapeMetadata({ ...updated, applicationKey: application!.key }, await getGrantedScopeKeys(updated.id));
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
    // D2-B — the generic API key surface is the OWNER's own keys only; managed integration credentials are not listed here.
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.credentialClass, "ORGANIZATION")))
    .orderBy(apiKeys.createdAt);

  const scopesByKeyId = await getGrantedScopeKeysByApiKeyId(rows.map((r) => r.id));
  return rows.map((row) => shapeMetadata(row, scopesByKeyId.get(row.id) ?? []));
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
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, organizationId), eq(apiKeys.credentialClass, "ORGANIZATION")))
    .limit(1);

  if (!row) throw new NotFoundError("API key not found");
  return shapeMetadata(row, await getGrantedScopeKeys(row.id));
}

export async function revokeApiKey(input: { organizationId: string; keyId: string; actorUserId: string }) {
  const [current] = await db
    .select({ id: apiKeys.id, status: apiKeys.status, applicationId: apiKeys.applicationId })
    .from(apiKeys)
    // D2-B — a managed integration credential is never revoked through the generic route (it is the integration's, not the OWNER's).
    .where(and(eq(apiKeys.id, input.keyId), eq(apiKeys.organizationId, input.organizationId), eq(apiKeys.credentialClass, "ORGANIZATION")))
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

  return shapeMetadata({ ...updated, applicationKey: application!.key }, await getGrantedScopeKeys(updated.id));
}

export interface VerifiedServiceCredential {
  apiKeyId: string;
  applicationId: string;
  applicationKey: string;
  organizationId: string | null;
  scopes: string[];
  /** D2-B — structural class and purpose, read from the row (never from the request). */
  credentialClass: CredentialClass;
  purpose: string | null;
  /** ACTIVE, or PENDING for an INTEGRATION_MANAGED credential still inside its confirmation window. */
  status: "ACTIVE" | "PENDING";
  provisioningRequestId: string | null;
}

/** D2-B — raised only AFTER the secret has been proven, so it tells the holder nothing it could not already know. */
export class CredentialRevokedError extends AppError {
  constructor() {
    super(401, "CREDENTIAL_REVOKED", "This credential has been revoked");
  }
}

/**
 * Verifies a presented `ulk_<id>.<secret>` token. Every failure —
 * malformed, unknown id, wrong secret, revoked, expired, or the owning
 * Application not ACTIVE — throws the same UnauthorizedError with the
 * same generic message, so no response ever reveals which case occurred
 * (see README "API Keys" security section). One D2-B exception: a REVOKED
 * INTEGRATION_MANAGED credential whose secret matched answers
 * CREDENTIAL_REVOKED, so the product holding it can retire its local copy.
 *
 * This proves WHO is calling, not whether the call is allowed right now:
 * a PENDING credential is returned (status "PENDING") and the commercial
 * runtime authorization is applied by `authenticate` (see
 * modules/integrationProvisioning/runtime.ts).
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
      createdAt: apiKeys.createdAt,
      organizationId: apiKeys.organizationId,
      applicationId: apiKeys.applicationId,
      credentialClass: apiKeys.credentialClass,
      purpose: apiKeys.purpose,
      provisioningRequestId: apiKeys.provisioningRequestId,
      applicationKey: applications.key,
      applicationStatus: applications.status,
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .where(eq(apiKeys.id, parsed.id))
    .limit(1);

  if (!row) throw new UnauthorizedError("Invalid API key");
  if (!secretMatchesHash(parsed.secret, row.secretHash)) throw new UnauthorizedError("Invalid API key");
  if (row.status === "REVOKED") {
    if (row.credentialClass === "INTEGRATION_MANAGED") throw new CredentialRevokedError();
    throw new UnauthorizedError("Invalid API key");
  }
  if (row.status === "PENDING") {
    // PENDING exists only for managed credentials (DB check) and only inside its confirmation window.
    if (row.credentialClass !== "INTEGRATION_MANAGED") throw new UnauthorizedError("Invalid API key");
    if (row.createdAt.getTime() + PENDING_CREDENTIAL_WINDOW_MS <= Date.now()) throw new UnauthorizedError("Invalid API key");
  } else if (row.status !== "ACTIVE") {
    throw new UnauthorizedError("Invalid API key");
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError("Invalid API key");
  if (row.applicationStatus !== "ACTIVE") throw new UnauthorizedError("Invalid API key");

  return {
    apiKeyId: row.id,
    applicationId: row.applicationId,
    applicationKey: row.applicationKey,
    organizationId: row.organizationId,
    scopes: await getGrantedScopeKeys(row.id),
    credentialClass: row.credentialClass,
    purpose: row.purpose,
    status: row.status,
    provisioningRequestId: row.provisioningRequestId,
  };
}
