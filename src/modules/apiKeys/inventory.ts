import { and, desc, eq, exists, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { apiKeyScopes, apiKeys, applications, CREDENTIAL_CLASSES, organizationApplicationAccess, organizations, serviceScopes } from "../../db/schema/index.js";
import { afterCursor, decodeCursor, page, preciseAt, withoutCursor } from "../../shared/keysetPagination.js";
import { recordAuditEvent } from "../audit/service.js";
import { ACCESS_NOT_EXPIRED_BY_GRANT } from "../entitlements/effectiveness.js";
import { getGrantedScopeKeysByApiKeyId } from "./service.js";

/**
 * Platform credential INVENTORY (audit 2026-10-23): every API key of every class and organization, as metadata only,
 * for a PLATFORM_ADMIN holding `platform.credential.read`. Read-only; never `secret_hash` or any cryptographic
 * material; key ids are masked (an inventory identifies, it does not act — revocation stays on the existing routes).
 *
 * Cost per request is constant, whatever the page size: one page query, one batched scopes query, one batched
 * organization-access query, one audit row. Nothing here is on the path of any other request.
 */
export const EFFECTIVE_STATUSES = ["ACTIVE", "PENDING", "REVOKED", "EXPIRED"] as const;

export const credentialInventoryQuerySchema = z
  .object({
    applicationKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/).optional(),
    organizationId: z.string().uuid().optional(),
    credentialClass: z.enum(CREDENTIAL_CLASSES).optional(),
    status: z.enum(EFFECTIVE_STATUSES).optional(),
    /** Keys holding this scope (e.g. `catalog.read`). */
    scope: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
export type CredentialInventoryQuery = z.infer<typeof credentialInventoryQuerySchema>;

/** What the inventory can and cannot tell — stated in every response so a reader never mistakes a gap for a fact. */
export const INVENTORY_KNOWLEDGE = {
  coverage: "Every credential class (ORGANIZATION, INTEGRATION_MANAGED, PLATFORM_SERVICE) of every organization matching the filters.",
  notRecorded: {
    consumer: "Which system or person uses a key is not stored (api_keys has no label).",
    lastUsedAt: "Use is not tracked per key (no lastUsedAt; inbound calls to products are not logged per key).",
  },
  notExposed: "Secrets, secret hashes and full key ids are never returned.",
  undeterminable: "Whether a key is still in use cannot be determined from this data; absence of evidence is not evidence of disuse.",
} as const;

const now = sql`now()`;
const statusCondition: Record<(typeof EFFECTIVE_STATUSES)[number], SQL> = {
  ACTIVE: and(eq(apiKeys.status, "ACTIVE"), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)))!,
  EXPIRED: and(eq(apiKeys.status, "ACTIVE"), lte(apiKeys.expiresAt, now))!,
  PENDING: eq(apiKeys.status, "PENDING"),
  REVOKED: eq(apiKeys.status, "REVOKED"),
};

function effectiveStatus(row: { status: string; expiresAt: Date | null }, at: number): (typeof EFFECTIVE_STATUSES)[number] {
  if (row.status === "ACTIVE" && row.expiresAt && row.expiresAt.getTime() <= at) return "EXPIRED";
  return row.status as (typeof EFFECTIVE_STATUSES)[number];
}

export async function listCredentialInventory(q: CredentialInventoryQuery, actor: { userId: string }) {
  const conditions: SQL[] = [];
  if (q.applicationKey) conditions.push(eq(applications.key, q.applicationKey));
  if (q.organizationId) conditions.push(eq(apiKeys.organizationId, q.organizationId));
  if (q.credentialClass) conditions.push(eq(apiKeys.credentialClass, q.credentialClass));
  if (q.status) conditions.push(statusCondition[q.status]);
  if (q.scope) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(apiKeyScopes)
          .innerJoin(serviceScopes, eq(serviceScopes.id, apiKeyScopes.serviceScopeId))
          .where(and(eq(apiKeyScopes.apiKeyId, apiKeys.id), eq(serviceScopes.key, q.scope))),
      ),
    );
  }
  if (q.cursor) conditions.push(afterCursor(apiKeys.createdAt, apiKeys.id, decodeCursor(q.cursor)));

  const rows = await db
    .select({
      id: apiKeys.id,
      application: applications.key,
      credentialClass: apiKeys.credentialClass,
      purpose: apiKeys.purpose,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
      organizationId: apiKeys.organizationId,
      organizationName: organizations.name,
      organizationStatus: organizations.status,
      cursorAt: preciseAt(apiKeys.createdAt),
    })
    .from(apiKeys)
    .innerJoin(applications, eq(applications.id, apiKeys.applicationId))
    .leftJoin(organizations, eq(organizations.id, apiKeys.organizationId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(q.limit + 1);
  const result = page(rows, q.limit, (r) => r.id);

  const scopesByKeyId = await getGrantedScopeKeysByApiKeyId(result.items.map((r) => r.id));
  const orgIds = [...new Set(result.items.map((r) => r.organizationId).filter((id): id is string => id !== null))];
  const access = orgIds.length
    ? await db
        .select({ organizationId: organizationApplicationAccess.organizationId, applicationKey: applications.key })
        .from(organizationApplicationAccess)
        .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
        .where(and(inArray(organizationApplicationAccess.organizationId, orgIds), eq(organizationApplicationAccess.status, "active"), ACCESS_NOT_EXPIRED_BY_GRANT))
    : [];

  await recordAuditEvent({
    actorUserId: actor.userId,
    action: "platform.credential.inventory_read",
    targetType: "api_key",
    metadata: { filters: { ...q, cursor: q.cursor ? "present" : undefined }, returned: result.items.length },
  });

  const at = Date.now();
  return {
    items: result.items.map(withoutCursor).map((r) => ({
      keyIdPrefix: `${r.id.slice(0, 8)}…`,
      application: r.application,
      credentialClass: r.credentialClass,
      purpose: r.purpose,
      status: effectiveStatus(r, at),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      scopes: scopesByKeyId.get(r.id) ?? [],
      organization: r.organizationId
        ? {
            id: r.organizationId,
            name: r.organizationName,
            status: r.organizationStatus,
            activeApplications: access.filter((a) => a.organizationId === r.organizationId).map((a) => a.applicationKey).sort(),
          }
        : null,
      consumer: null,
      lastUsedAt: null,
    })),
    nextCursor: result.nextCursor,
    knowledge: INVENTORY_KNOWLEDGE,
  };
}
