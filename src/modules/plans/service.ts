import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, planEntitlements, plans } from "../../db/schema/index.js";
import { getApplicationByKey } from "../applications/service.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * The catalog list only shows plans still open to new subscriptions.
 * `getPlanDetail` deliberately does NOT filter by status — a plan that's
 * ARCHIVED still needs to be inspectable (e.g. by an existing
 * subscription resolving its entitlements later), it just shouldn't be
 * offered as something new to subscribe to.
 */
export async function listPlansForApplication(applicationKey: string) {
  await getApplicationByKey(applicationKey); // throws NotFoundError if the application itself is unknown

  return db
    .select({
      key: plans.key,
      name: plans.name,
      description: plans.description,
      status: plans.status,
    })
    .from(plans)
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(and(eq(applications.key, applicationKey), eq(plans.status, "ACTIVE")))
    .orderBy(plans.key);
}

export async function getPlanDetail(applicationKey: string, planKey: string) {
  const application = await getApplicationByKey(applicationKey);

  const [plan] = await db
    .select({
      id: plans.id,
      key: plans.key,
      name: plans.name,
      description: plans.description,
      status: plans.status,
    })
    .from(plans)
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .where(and(eq(applications.key, applicationKey), eq(plans.key, planKey)))
    .limit(1);

  if (!plan) {
    throw new NotFoundError(`Unknown plan: ${planKey} for application ${applicationKey}`);
  }

  const entitlements = await db
    .select({ key: planEntitlements.key, value: planEntitlements.value })
    .from(planEntitlements)
    .where(eq(planEntitlements.planId, plan.id))
    .orderBy(planEntitlements.key);

  return {
    application: { key: application.key, name: application.name },
    plan: {
      key: plan.key,
      name: plan.name,
      description: plan.description,
      status: plan.status,
      entitlements,
    },
  };
}
