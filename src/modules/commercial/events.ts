import { db } from "../../db/index.js";
import { COMMERCIAL_ACTOR_TYPES, COMMERCIAL_AGGREGATE_TYPES, commercialEvents } from "../../db/schema/index.js";

/**
 * Block 1B — business facts of the commercial domain (proposal.created,
 * proposal.version.sent, proposal.viewed, …), written with the SAME executor
 * (transaction) as the change they describe: unlike `recordAuditEvent`
 * (best-effort security log), a failure here fails the operation. Payloads
 * carry identifiers and hashes, never tokens or secrets. Reads are never
 * events (except the first view of a link, which is a business fact).
 */
export interface CommercialEventInput {
  aggregateType: (typeof COMMERCIAL_AGGREGATE_TYPES)[number];
  aggregateId: string;
  eventType: string;
  organizationId?: string | null;
  actorType: (typeof COMMERCIAL_ACTOR_TYPES)[number];
  actorUserId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordCommercialEvent(executor: Pick<typeof db, "insert">, event: CommercialEventInput): Promise<void> {
  await executor.insert(commercialEvents).values({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    organizationId: event.organizationId ?? null,
    actorType: event.actorType,
    actorUserId: event.actorUserId ?? null,
    correlationId: event.correlationId ?? null,
    idempotencyKey: event.idempotencyKey ?? null,
    payload: event.payload ?? {},
  });
}

/** Who did it and under which request — passed from the route to every service call. */
export interface CommercialActor {
  userId: string;
  requestId?: string;
}
