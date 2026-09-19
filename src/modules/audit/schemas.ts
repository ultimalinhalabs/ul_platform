import { z } from "zod";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/**
 * Query filters for GET /v1/platform/audit-logs. `cursor` is opaque to the
 * client — see service.ts's encodeCursor/decodeCursor — never a raw
 * offset, so pagination stays stable even as new rows are inserted ahead
 * of a page the caller is still paging through.
 */
export const platformAuditLogQuerySchema = z.object({
  action: z.string().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
