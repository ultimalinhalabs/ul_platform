import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, organizations, plans, subscriptions } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

/**
 * Any status other than `canceled` is a live relationship — see
 * subscriptions.ts. This is the ONE canonical "grants access" predicate;
 * reuse it (import it) rather than re-deriving `ne(status, "canceled")`
 * elsewhere — modules/entitlements/service.ts does exactly that.
 */
export const NOT_CANCELED = ne(subscriptions.status, "canceled");

const SUBSCRIPTION_ROW = {
  id: subscriptions.id,
  status: subscriptions.status,
  currentPeriodStart: subscriptions.currentPeriodStart,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  canceledAt: subscriptions.canceledAt,
  applicationKey: applications.key,
  applicationName: applications.name,
  planKey: plans.key,
  planName: plans.name,
} as const;

function shapeSubscription(row: {
  id: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  applicationKey: string;
  applicationName: string;
  planKey: string;
  planName: string;
}) {
  return {
    id: row.id,
    application: { key: row.applicationKey, name: row.applicationName },
    plan: { key: row.planKey, name: row.planName },
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    canceledAt: row.canceledAt,
  };
}

async function resolvePlanForSubscription(applicationKey: string, planKey: string) {
  const [row] = await db
    .select({
      planId: plans.id,
      planStatus: plans.status,
      applicationId: applications.id,
      applicationStatus: applications.status,
    })
    .from(plans)
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(and(eq(applications.key, applicationKey), eq(plans.key, planKey)))
    .limit(1);

  if (!row) {
    throw new NotFoundError(`Unknown plan: ${planKey} for application ${applicationKey}`);
  }
  return row;
}

/**
 * Creates a Subscription. Enforces, in order: the application/plan exist,
 * the application is ACTIVE (SUSPENDED/DEPRECATED reject new subscriptions
 * but never touch existing ones), the plan is ACTIVE (ARCHIVED rejects new
 * subscriptions only), and — the rule a single-table unique index can't
 * express, since Application is only reachable via planId — that this
 * organization has no other non-canceled subscription for the same
 * application (different plan, same app, would otherwise be ambiguous:
 * which plan's entitlements apply?).
 *
 * That last check races under concurrent requests for the same
 * organization, so it runs inside a transaction that first takes
 * `SELECT ... FOR UPDATE` on the organization row — this serializes
 * concurrent subscription-creation attempts for that organization,
 * making the check-then-insert atomic in effect. The narrower "same plan
 * twice" case additionally has a real database constraint
 * (`subscriptions_org_plan_not_canceled_unique`) as a second, independent
 * safety net.
 */
export async function createSubscription(input: {
  organizationId: string;
  applicationKey: string;
  planKey: string;
  actorUserId: string;
}) {
  const target = await resolvePlanForSubscription(input.applicationKey, input.planKey);

  if (target.applicationStatus !== "ACTIVE") {
    throw new ConflictError(
      `Application ${input.applicationKey} is not accepting new subscriptions (status: ${target.applicationStatus})`,
    );
  }
  if (target.planStatus !== "ACTIVE") {
    throw new ConflictError(
      `Plan ${input.planKey} is not accepting new subscriptions (status: ${target.planStatus})`,
    );
  }

  return db.transaction(async (tx) => {
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update");

    const [existing] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(
        and(
          eq(subscriptions.organizationId, input.organizationId),
          eq(plans.applicationId, target.applicationId),
          NOT_CANCELED,
        ),
      )
      .limit(1);

    if (existing) {
      throw new ConflictError(
        `Organization already has an active subscription for ${input.applicationKey}`,
      );
    }

    const [subscription] = await tx
      .insert(subscriptions)
      .values({
        organizationId: input.organizationId,
        planId: target.planId,
        status: "active",
        currentPeriodStart: new Date(),
      })
      .returning();
    if (!subscription) throw new Error("Failed to create subscription");

    await recordAuditEvent(
      {
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        applicationId: target.applicationId,
        action: "subscription.created",
        targetType: "subscription",
        targetId: subscription.id,
        metadata: { applicationKey: input.applicationKey, planKey: input.planKey },
      },
      tx,
    );

    return subscription;
  });
}

export async function listSubscriptionsForOrganization(organizationId: string) {
  const rows = await db
    .select(SUBSCRIPTION_ROW)
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(eq(subscriptions.organizationId, organizationId))
    .orderBy(subscriptions.createdAt);

  return rows.map(shapeSubscription);
}

/** Tenant-safe by construction: organizationId is always part of the WHERE, never checked after the fact. */
export async function getSubscriptionDetail(organizationId: string, subscriptionId: string) {
  const [row] = await db
    .select(SUBSCRIPTION_ROW)
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.organizationId, organizationId)))
    .limit(1);

  if (!row) throw new NotFoundError("Subscription not found");
  return shapeSubscription(row);
}

export async function cancelSubscription(input: {
  organizationId: string;
  subscriptionId: string;
  actorUserId: string;
}) {
  const [current] = await db
    .select({ id: subscriptions.id, status: subscriptions.status })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.organizationId, input.organizationId)),
    )
    .limit(1);
  if (!current) throw new NotFoundError("Subscription not found");
  if (current.status === "canceled") throw new ConflictError("Subscription is already canceled");

  const [updated] = await db
    .update(subscriptions)
    .set({ status: "canceled", canceledAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptions.id, input.subscriptionId))
    .returning();
  if (!updated) throw new NotFoundError("Subscription not found");

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    action: "subscription.canceled",
    targetType: "subscription",
    targetId: input.subscriptionId,
  });

  return updated;
}

/** Applications this organization currently has effective commercial access to, derived from its subscriptions — no parallel table. */
export async function listOrganizationApplications(organizationId: string) {
  const rows = await db
    .select({
      applicationKey: applications.key,
      applicationName: applications.name,
      planKey: plans.key,
      planName: plans.name,
      subscriptionStatus: subscriptions.status,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(and(eq(subscriptions.organizationId, organizationId), NOT_CANCELED))
    .orderBy(applications.key);

  return rows.map((row) => ({
    application: { key: row.applicationKey, name: row.applicationName },
    plan: { key: row.planKey, name: row.planName },
    subscription: { status: row.subscriptionStatus },
  }));
}

/**
 * "Does this organization have access" — the boolean half of Effective
 * Access. See modules/entitlements/service.ts for the value-resolving
 * half (`getEffectiveEntitlements`), which reuses this same NOT_CANCELED
 * predicate rather than re-deriving it.
 */
export async function hasApplicationAccess(
  organizationId: string,
  applicationKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: subscriptions.id })
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
    .limit(1);

  return Boolean(row);
}
