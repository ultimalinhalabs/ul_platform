import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  entitlementDefinitions,
  entitlementGrants,
  grantEntitlementValues,
  organizationApplicationAccess,
  organizations,
  planEntitlements,
  plans,
  subscriptions,
} from "../../db/schema/index.js";
import { getApplicationByKey } from "../applications/service.js";
import { isGrantEffective, SUBSCRIPTION_EFFECTIVE } from "./effectiveness.js";
import { NotFoundError } from "../../shared/errors.js";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 * see below) EFFECTIVE subscription for (organizationId, applicationKey):
 * non-canceled and within its period (Block 1D, `SUBSCRIPTION_EFFECTIVE`
 * in ./effectiveness.ts) — one canonical rule shared with the derived
 * application list, not copies of `status !== "canceled"`.
 *
 * Migration 0031 (audit 2026-10-20) — where the values come from, and when nothing is granted:
 *  - a subscription backed by a contractual grant takes the values FROZEN on that grant at activation
 *    (`grant_entitlement_values`, source `contract`): editing the plan never changes an accepted contract.
 *    A grant activated before 0031 without frozen values falls back to the plan until it is backfilled;
 *  - a subscription with no grant (pre-commercial) takes the plan's live values (source `plan`), as before;
 *  - nothing is granted (`access.effective = false`, `entitlements: []`) when the organization is suspended,
 *    its access to the application was revoked, or the subscription's grant is no longer effective
 *    (expired/revoked) — the same answer for a human and for a service credential.
 * `entitlements[]` keeps `{ key, value }` and only adds fields, so existing consumers are unaffected.
 */

export type AccessReason = "NO_SUBSCRIPTION" | "ORGANIZATION_SUSPENDED" | "APPLICATION_ACCESS_REVOKED" | "GRANT_NOT_EFFECTIVE";

export interface ResolvedEntitlement {
  key: string;
  value: unknown;
  type: "boolean" | "limit" | null;
  source: "contract" | "plan";
  validUntil: string | null;
}

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
      currentPeriodEnd: subscriptions.currentPeriodEnd,
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
        // Block 1D: non-canceled AND within its period — an expired subscription grants nothing even before
        // any housekeeping flips its stored status (NULL period end = no fixed end, unchanged behaviour).
        SUBSCRIPTION_EFFECTIVE,
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * The values one effective subscription grants, and the grant behind it (if any). Shared with the member
 * limit (memberships/memberLimit.ts) so both read a contract's frozen values the same way.
 *  - `grant: null` → no contractual grant (pre-commercial): live plan values.
 *  - `grant.effective = false` → the contract no longer grants anything: no values.
 */
export async function valuesForSubscription(
  executor: Executor,
  subscription: { subscriptionId: string; planId: string },
): Promise<{ grant: { id: string; effective: boolean; endsAt: Date | null } | null; values: Array<{ key: string; value: unknown; source: "contract" | "plan" }> }> {
  const grants = await executor
    .select({ id: entitlementGrants.id, status: entitlementGrants.status, endsAt: entitlementGrants.endsAt })
    .from(entitlementGrants)
    .where(eq(entitlementGrants.subscriptionId, subscription.subscriptionId))
    .orderBy(desc(entitlementGrants.createdAt));
  const planValues = async () =>
    (await executor.select({ key: planEntitlements.key, value: planEntitlements.value }).from(planEntitlements).where(eq(planEntitlements.planId, subscription.planId)).orderBy(asc(planEntitlements.key))).map(
      (v) => ({ ...v, source: "plan" as const }),
    );
  if (grants.length === 0) return { grant: null, values: await planValues() };
  const effective = grants.find((g) => isGrantEffective(g));
  if (!effective) return { grant: { id: grants[0]!.id, effective: false, endsAt: grants[0]!.endsAt }, values: [] };
  const frozen = await executor
    .select({ key: grantEntitlementValues.key, value: grantEntitlementValues.value })
    .from(grantEntitlementValues)
    .where(eq(grantEntitlementValues.grantId, effective.id))
    .orderBy(asc(grantEntitlementValues.key));
  const grant = { id: effective.id, effective: true, endsAt: effective.endsAt };
  if (frozen.length === 0) return { grant, values: await planValues() };
  return { grant, values: frozen.map((v) => ({ ...v, source: "contract" as const })) };
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
  const resolvedAt = new Date().toISOString();
  const base = { application: { key: application.key, name: application.name } };
  const none = (reason: AccessReason, subscription: { id: string; status: string; planKey: string; currentPeriodEnd: string | null } | null) => ({
    ...base,
    access: { effective: false as boolean, reason: reason as AccessReason | null },
    subscription,
    entitlements: [] as ResolvedEntitlement[],
    resolvedAt,
  });

  if (!granting) return none("NO_SUBSCRIPTION", null);
  const subscription = {
    id: granting.subscriptionId,
    status: granting.status,
    planKey: granting.planKey,
    currentPeriodEnd: granting.currentPeriodEnd?.toISOString() ?? null,
  };

  const [org] = await db.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, organizationId));
  if (org?.status !== "active") return none("ORGANIZATION_SUSPENDED", subscription);
  const [access] = await db
    .select({ status: organizationApplicationAccess.status })
    .from(organizationApplicationAccess)
    .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
    .where(and(eq(organizationApplicationAccess.organizationId, organizationId), eq(applications.key, applicationKey)));
  // No access row = pre-commercial organization (Fase 6 semantics: access is additive); a revoked one denies.
  if (access?.status === "revoked") return none("APPLICATION_ACCESS_REVOKED", subscription);

  const { grant, values } = await valuesForSubscription(db, granting);
  if (grant && !grant.effective) return none("GRANT_NOT_EFFECTIVE", subscription);

  const definitions = await db
    .select({ key: entitlementDefinitions.key, valueType: entitlementDefinitions.valueType })
    .from(entitlementDefinitions)
    .innerJoin(applications, eq(applications.id, entitlementDefinitions.applicationId))
    .where(eq(applications.key, applicationKey));
  const typeByKey = new Map(definitions.map((d) => [d.key, d.valueType]));
  const validUntil = (grant?.endsAt ?? granting.currentPeriodEnd)?.toISOString() ?? null;

  return {
    ...base,
    access: { effective: true as boolean, reason: null as AccessReason | null },
    subscription,
    entitlements: values.map((v): ResolvedEntitlement => ({ key: v.key, value: v.value, type: typeByKey.get(v.key) ?? null, source: v.source, validUntil })),
    resolvedAt,
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
    access: resolved.access,
    subscription: resolved.subscription,
    entitlement,
  };
}
