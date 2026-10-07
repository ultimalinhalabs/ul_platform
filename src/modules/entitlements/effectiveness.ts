import { and, gt, isNull, ne, or, sql } from "drizzle-orm";
import { subscriptions } from "../../db/schema/index.js";

/**
 * Block 1D — temporal validity is enforced at READ time. A subscription or a
 * contractual grant past its end must stop granting access immediately, even
 * if no housekeeping job has yet flipped its stored status (there is no such
 * job yet). Pure predicates for code, SQL conditions for queries; both say
 * the same thing.
 *
 *  - subscription effective ⇔ status ≠ canceled AND (current_period_end IS NULL OR current_period_end > now)
 *    (NULL end = no fixed end: the pre-commercial subscriptions keep working exactly as before)
 *  - grant effective        ⇔ status = active AND (ends_at IS NULL OR ends_at > now)
 *  - application access     ⇔ access row active AND it is NOT backed by an active contractual grant whose ends_at passed
 *    (access granted manually — no grant — keeps the Fase 6 semantics)
 */
export function isSubscriptionEffective(row: { status: string; currentPeriodEnd: Date | null }, now: Date = new Date()): boolean {
  return row.status !== "canceled" && (row.currentPeriodEnd === null || row.currentPeriodEnd.getTime() > now.getTime());
}

export function isGrantEffective(row: { status: string; endsAt: Date | null }, now: Date = new Date()): boolean {
  return row.status === "active" && (row.endsAt === null || row.endsAt.getTime() > now.getTime());
}

/** SQL counterpart of `isSubscriptionEffective` for queries on `subscriptions`. */
export const SUBSCRIPTION_EFFECTIVE = and(ne(subscriptions.status, "canceled"), or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, sql`now()`)))!;

/** SQL condition on `organization_application_access` rows: not backed by a time-expired active grant. */
export const ACCESS_NOT_EXPIRED_BY_GRANT = sql`not exists (
  select 1 from "entitlement_grants" g
  where g."application_access_id" = "organization_application_access"."id"
    and g."status" = 'active' and g."ends_at" is not null and g."ends_at" <= now()
)`;
