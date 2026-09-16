import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, planEntitlements, plans, subscriptions } from "../../db/schema/index.js";
import { getApplicationByKey } from "../applications/service.js";
import { NOT_CANCELED } from "../subscriptions/service.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Effective Entitlements — what an organization's *current subscription*
 * resolves to for one application. Distinct from:
 *  - `plan_entitlements`: what a Plan *offers*, organization-agnostic.
 *  - `entitlements` (schema-reserved, still untouched): a *materialized*
 *    version of this same result. Deliberately not written here — this
 *    resolves synchronously on every read instead (no background jobs,
 *    no caching yet; see README "Effective Entitlements"). Revisit only
 *    if a concrete performance/product need for a persisted copy shows up.
 *
 * The granting subscription is "the" (at most one, by construction —
 * see below) non-canceled subscription for (organizationId,
 * applicationKey), reusing the exact same NOT_CANCELED predicate as
 * application access and subscription creation — one canonical rule,
 * not three copies of `status !== "canceled"`.
 */

/**
 * `createSubscription`'s transactional per-application uniqueness check
 * is the only write path for subscriptions, so at most one non-canceled
 * subscription per (organization, application) exists today — this
 * still orders by most-recently-created and takes one row rather than
 * assuming exactly one, so resolution stays deterministic (never a
 * crash, never an ad-hoc merge) even if that invariant is ever relaxed.
 * No entitlement-merging engine is built on the assumption it'll be needed.
 */
async function getGrantingSubscription(organizationId: string, applicationKey: string) {
  const [row] = await db
    .select({
      subscriptionId: subscriptions.id,
      status: subscriptions.status,
      planId: plans.id,
      planKey: plans.key,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(
      and(
        eq(subscriptions.organizationId, organizationId),
        eq(applications.key, applicationKey),
        NOT_CANCELED,
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * Resolves the full effective entitlement set. Returns a 200-shaped
 * result with `subscription: null, entitlements: []` when the
 * organization has no granting subscription (no access) or is
 * subscribed to a *different* application — that is a true, meaningful
 * answer ("this org currently has nothing here"), not a 404: the
 * application itself must exist (404 if not), but "zero entitlements
 * for an org with no subscription" is not an error condition.
 */
export async function getEffectiveEntitlements(organizationId: string, applicationKey: string) {
  const application = await getApplicationByKey(applicationKey);
  const granting = await getGrantingSubscription(organizationId, applicationKey);

  if (!granting) {
    return {
      application: { key: application.key, name: application.name },
      subscription: null,
      entitlements: [] as { key: string; value: unknown }[],
    };
  }

  const entitlements = await db
    .select({ key: planEntitlements.key, value: planEntitlements.value })
    .from(planEntitlements)
    .where(eq(planEntitlements.planId, granting.planId))
    .orderBy(planEntitlements.key);

  return {
    application: { key: application.key, name: application.name },
    subscription: { id: granting.subscriptionId, status: granting.status, planKey: granting.planKey },
    entitlements,
  };
}

/** 404 when this key has no effective value — whether because there's no granting subscription or the plan simply doesn't include it. Uniform semantics either way. */
export async function getEffectiveEntitlement(
  organizationId: string,
  applicationKey: string,
  key: string,
) {
  const resolved = await getEffectiveEntitlements(organizationId, applicationKey);
  const entitlement = resolved.entitlements.find((e) => e.key === key);
  if (!entitlement) {
    throw new NotFoundError(`No effective value for entitlement "${key}" on ${applicationKey}`);
  }
  return {
    application: resolved.application,
    subscription: resolved.subscription,
    entitlement,
  };
}
