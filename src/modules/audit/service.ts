import { db } from "../../db/index.js";
import { auditLogs } from "../../db/schema/index.js";

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
