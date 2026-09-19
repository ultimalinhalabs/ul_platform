import { and, desc, eq, isNull, like, lt, lte, or, gte, SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, auditLogs, users } from "../../db/schema/index.js";
import { ValidationError } from "../../shared/errors.js";

export interface AuditEntry {
  actorUserId?: string;
  organizationId?: string;
  applicationId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records a single security-sensitive operation. Never throws to the
 * caller — a broken audit write must not break the underlying business
 * operation. Pass `executor` (a transaction handle) when called as part of
 * a larger transaction so the audit row commits/rolls back atomically with
 * the rest of that operation instead of on its own connection.
 */
export async function recordAuditEvent(
  entry: AuditEntry,
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  try {
    await executor.insert(auditLogs).values(entry);
  } catch (error) {
    console.error("Failed to record audit event", entry.action, error);
  }
}

export interface PlatformAuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  applicationKey: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface PlatformAuditLogFilters {
  action?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

/** Opaque to the client by design — see modules/audit/schemas.ts. */
function encodeCursor(row: Cursor): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ValidationError("Invalid cursor");
  }
  const [createdAtRaw, id] = raw.split("|");
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : undefined;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || !id) {
    throw new ValidationError("Invalid cursor");
  }
  return { createdAt, id };
}

/**
 * Every action prefix a control-plane event is ever written with — see
 * the actual `recordAuditEvent({ action: "..." })` call sites:
 * `platform.application.*`/`platform.admin.*`/`platform.credential.*`
 * (modules/applications, platformAdmins, apiKeys),
 * `environment.*`/`endpoint.*` (modules/environments, endpoints),
 * `integration.*` (modules/integrations). Every tenant action lives in a
 * disjoint namespace (`membership.*`, `organization.*`, `subscription.*`,
 * `webhook.*`, `api_key.*`) and can never collide with one of these
 * prefixes — see README's audit action taxonomy for the full list kept in
 * sync with this constant.
 */
const CONTROL_PLANE_ACTION_PREFIXES = ["platform.", "environment.", "endpoint.", "integration."] as const;

/**
 * Control-plane audit log, for `GET /v1/platform/audit-logs` — gated
 * behind `platform.audit.read`. The boundary against tenant/Organization
 * events is the `action` string's own namespace
 * (`CONTROL_PLANE_ACTION_PREFIXES`), hard-coded here and never a
 * caller-supplied filter — **not** `organizationId IS NULL`, which was
 * tried first and found unsound: `audit_logs.organizationId` has `ON
 * DELETE SET NULL` (see db/schema/audit.ts), so once an Organization is
 * deleted every tenant event that ever referenced it — `api_key.created`,
 * `membership.*`, `subscription.*`, `webhook.*` — retroactively reads as
 * `organizationId: null` too, which would silently let old tenant history
 * leak into this endpoint after the tenant itself is long gone. The
 * `action` prefix is set once at insert time and never mutates, so it
 * can't be cascaded away like a foreign key. `organizationId IS NULL` is
 * kept as a second, redundant condition (defense in depth: even a
 * mis-prefixed future action can't leak a row that still points at a live
 * Organization) — see tests/platform-audit.test.ts's
 * "organizationId retroactively nulled by ON DELETE SET NULL" case.
 *
 * Keyset pagination on `(createdAt, id)` descending — never a raw
 * `OFFSET`, which would drift as new rows are inserted ahead of a page a
 * caller is still working through. `cursor` is opaque (see
 * encodeCursor/decodeCursor); `limit` is capped by the Zod schema before
 * this ever runs.
 */
export async function listPlatformAuditLogs(
  filters: PlatformAuditLogFilters,
): Promise<{ items: PlatformAuditLogEntry[]; nextCursor: string | null }> {
  const conditions: SQL[] = [
    or(...CONTROL_PLANE_ACTION_PREFIXES.map((prefix) => like(auditLogs.action, `${prefix}%`)))!,
    isNull(auditLogs.organizationId),
  ];

  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  if (filters.actorUserId) conditions.push(eq(auditLogs.actorUserId, filters.actorUserId));
  if (filters.targetType) conditions.push(eq(auditLogs.targetType, filters.targetType));
  if (filters.targetId) conditions.push(eq(auditLogs.targetId, filters.targetId));
  if (filters.from) conditions.push(gte(auditLogs.createdAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogs.createdAt, filters.to));

  if (filters.cursor) {
    const { createdAt, id } = decodeCursor(filters.cursor);
    conditions.push(
      or(lt(auditLogs.createdAt, createdAt), and(eq(auditLogs.createdAt, createdAt), lt(auditLogs.id, id))!)!,
    );
  }

  const rows = await db
    .select({
      id: auditLogs.id,
      actorUserId: auditLogs.actorUserId,
      actorEmail: users.email,
      applicationKey: applications.key,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .leftJoin(applications, eq(applications.id, auditLogs.applicationId))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    // Fetch one extra row past the page to know whether a next page exists,
    // without a separate COUNT query.
    .limit(filters.limit + 1);

  const hasMore = rows.length > filters.limit;
  const items = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items, nextCursor };
}
