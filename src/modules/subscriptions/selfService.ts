/**
 * Block 0 — commercial authority. Every plan is CONTRACTUAL by default: an
 * organization cannot subscribe itself through
 * `POST /organizations/:organizationId/subscriptions`; paid access comes from
 * the commercial flow run by Última Linha (proposal → contract → activation),
 * which calls `createSubscription()` directly and is not gated by this list.
 *
 * A plan becomes self-service only by being listed here explicitly, as
 * `APPLICATION_KEY/PLAN_KEY`. Empty today: no plan is self-service. When this
 * needs to be data rather than code, it becomes a `plans` column (e.g.
 * `purchase_mode: self_service | contractual`, default `contractual`).
 */
export const SELF_SERVICE_PLANS: ReadonlySet<string> = new Set<string>([]);

export function isSelfServicePlan(applicationKey: string, planKey: string, selfServicePlans: ReadonlySet<string> = SELF_SERVICE_PLANS): boolean {
  return selfServicePlans.has(`${applicationKey}/${planKey}`);
}
