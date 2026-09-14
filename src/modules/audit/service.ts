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

/** Records a single security-sensitive operation. Never throws to the caller. */
export async function recordAuditEvent(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values(entry);
  } catch (error) {
    console.error("Failed to record audit event", entry.action, error);
  }
}
