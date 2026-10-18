import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { applications, commercialTermsTemplates, organizations, planEntitlements, plans, proposals, proposalVersions, subscriptions, users } from "../../db/schema/index.js";
import { AppError, ConflictError, EmailNotVerifiedError, ForbiddenError, isUniqueViolationError, NotFoundError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { findActiveMembership } from "../memberships/service.js";
import { findActivePlatformAdmin } from "../platformAdmins/service.js";
import { isEmailVerified } from "../users/service.js";
import { createSelfServiceProposalInTx } from "./proposals.service.js";

/**
 * Migration 0024 — self-service contracting on the SAME commercial
 * infrastructure as the assisted channel:
 *
 *   catalog plan (purchase_mode self_service, price/currency/period/terms)
 *     → createSelfServiceProposalInTx (proposal channel self_service, frozen)
 *     → existing acceptance (POST /v1/proposals/:id/acceptance) → contract
 *     → payment confirmation (manual or integration) → activateContract.
 *
 * No price, duration, limit or term ever comes from the client: the request
 * names a plan, the server reads the catalog. Commercial values are set by a
 * platform administrator (configurePlanCommercial) and must be values UL has
 * approved; this module invents none.
 */

const PLAN_KEY = z.string().min(1).max(100);

export const configurePlanCommercialSchema = z
  .object({
    purchaseMode: z.enum(["contractual", "self_service"]),
    priceMinor: z.string().regex(/^\d{1,18}$/).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    periodDays: z.number().int().min(1).max(3660).nullable(),
    termsTemplateId: z.string().uuid().nullable(),
  })
  .strict();

export const startSelfServiceSchema = z.object({ applicationKey: PLAN_KEY, planKey: PLAN_KEY }).strict();

type PlanRow = typeof plans.$inferSelect;

async function planWithTerms(applicationKey: string, planKey: string) {
  const [row] = await db
    .select({ plan: plans, application: applications, terms: commercialTermsTemplates })
    .from(plans)
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .leftJoin(commercialTermsTemplates, eq(commercialTermsTemplates.id, plans.termsTemplateId))
    .where(and(eq(applications.key, applicationKey), eq(plans.key, planKey)))
    .limit(1);
  return row ?? null;
}

function catalogEntry(row: NonNullable<Awaited<ReturnType<typeof planWithTerms>>>, entitlements: Array<{ key: string; value: unknown }>) {
  const { plan, application, terms } = row;
  return {
    applicationKey: application.key,
    applicationName: application.name,
    planKey: plan.key,
    name: plan.name,
    description: plan.description,
    priceMinor: plan.priceMinor!.toString(),
    currency: plan.currency!,
    periodDays: plan.periodDays!,
    paymentRequired: true,
    entitlements,
    terms: terms ? { id: terms.id, key: terms.key, version: terms.version, title: terms.title, status: terms.status, bodySha256: terms.bodySha256 } : null,
    /** Contracting requires APPROVED terms; a plan whose terms are still a draft is listed as not yet contractable. */
    contractable: plan.status === "ACTIVE" && application.status === "ACTIVE" && terms?.status === "approved",
  };
}

/** Self-service catalog: ACTIVE self-service plans of ACTIVE applications, with their price, period, entitlements and terms. */
export async function listSelfServiceCatalog(applicationKey?: string) {
  const rows = await db
    .select({ plan: plans, application: applications, terms: commercialTermsTemplates })
    .from(plans)
    .innerJoin(applications, eq(applications.id, plans.applicationId))
    .leftJoin(commercialTermsTemplates, eq(commercialTermsTemplates.id, plans.termsTemplateId))
    .where(
      and(
        eq(plans.purchaseMode, "self_service"),
        eq(plans.status, "ACTIVE"),
        eq(applications.status, "ACTIVE"),
        ...(applicationKey ? [eq(applications.key, applicationKey)] : []),
      ),
    );
  const out = [];
  for (const row of rows) {
    const ents = await db.select({ key: planEntitlements.key, value: planEntitlements.value }).from(planEntitlements).where(eq(planEntitlements.planId, row.plan.id));
    out.push(catalogEntry(row, ents));
  }
  return out;
}

/** Platform administrator: set (or clear) a plan's commercial catalog values. Audited; never touches accepted contracts (they keep their frozen copy). */
export async function configurePlanCommercial(applicationKey: string, planKey: string, input: z.infer<typeof configurePlanCommercialSchema>, actor: { userId: string }) {
  const row = await planWithTerms(applicationKey, planKey);
  if (!row) throw new NotFoundError("Plan not found");
  if (input.termsTemplateId) {
    const [terms] = await db.select({ id: commercialTermsTemplates.id }).from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, input.termsTemplateId)).limit(1);
    if (!terms) throw new NotFoundError("Terms template not found");
  }
  if (input.purchaseMode === "self_service" && (input.priceMinor === null || input.currency === null || input.periodDays === null || input.termsTemplateId === null)) {
    throw new AppError(400, "VALIDATION_ERROR", "A self-service plan needs priceMinor, currency, periodDays and termsTemplateId");
  }
  const [updated] = await db
    .update(plans)
    .set({
      purchaseMode: input.purchaseMode,
      priceMinor: input.priceMinor === null ? null : BigInt(input.priceMinor),
      currency: input.currency,
      periodDays: input.periodDays,
      termsTemplateId: input.termsTemplateId,
      updatedAt: new Date(),
    })
    .where(eq(plans.id, row.plan.id))
    .returning();
  await recordAuditEvent({
    actorUserId: actor.userId,
    applicationId: row.application.id,
    action: "platform.commercial.plan.catalog_updated",
    targetType: "plan",
    targetId: row.plan.id,
    metadata: { applicationKey, planKey, ...input },
  });
  return planCommercialDto(updated!, applicationKey);
}

function planCommercialDto(plan: PlanRow, applicationKey: string) {
  return {
    applicationKey,
    planKey: plan.key,
    purchaseMode: plan.purchaseMode,
    priceMinor: plan.priceMinor?.toString() ?? null,
    currency: plan.currency,
    periodDays: plan.periodDays,
    termsTemplateId: plan.termsTemplateId,
  };
}

/**
 * An OWNER of an ACTIVE organization, with a verified email, starts a
 * self-service contracting for a catalog plan. Returns what the acceptance
 * endpoint needs (proposal/version/option ids and the frozen content hash).
 * Idempotent per (user, Idempotency-Key): the same key for the same
 * organization and plan returns the same contracting (200); with anything else
 * it is a 409.
 */
export async function startSelfServiceContracting(
  organizationId: string,
  input: z.infer<typeof startSelfServiceSchema>,
  idempotencyKey: string,
  actor: { userId: string; requestId?: string },
) {
  if (await findActivePlatformAdmin(actor.userId)) throw new ForbiddenError("Platform administrators cannot contract on behalf of a client");
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user?.email || !(await isEmailVerified(actor.userId))) throw new EmailNotVerifiedError();
  const membership = await findActiveMembership(actor.userId, organizationId);
  if (!membership || membership.roleKey !== "OWNER") throw new ForbiddenError("Only an active OWNER of the organization can contract for it");
  if (membership.organizationStatus !== "active") throw new AppError(403, "ORGANIZATION_SUSPENDED", "This organization is suspended");

  const existing = await replayOf(actor.userId, idempotencyKey);
  if (existing) {
    if (existing.organizationId === organizationId && existing.applicationKey === input.applicationKey && existing.planKey === input.planKey) return { ...existing.result, replayed: true };
    throw new ConflictError("This Idempotency-Key was already used for a different contracting");
  }

  const row = await planWithTerms(input.applicationKey, input.planKey);
  if (!row || row.plan.purchaseMode !== "self_service") throw new NotFoundError("This plan is not available for self-service contracting");
  const { plan, application, terms } = row;
  if (plan.status !== "ACTIVE" || application.status !== "ACTIVE") throw new AppError(409, "PLAN_INACTIVE", "This plan is not currently offered");
  if (!terms || terms.status !== "approved") throw new AppError(409, "TERMS_NOT_APPROVED", "The terms of this plan are not approved yet");

  const contract = async () => db.transaction(async (tx) => {
    const [sub] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.organizationId, organizationId), eq(plans.applicationId, application.id), ne(subscriptions.status, "canceled")))
      .limit(1);
    if (sub) throw new AppError(409, "SUBSCRIPTION_CONFLICT", `The organization already has a subscription for ${application.key}`);
    const [org] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId));
    const validUntil = new Date(Date.now() + env.SELF_SERVICE_OFFER_VALIDITY_HOURS * 3_600_000);
    const created = await createSelfServiceProposalInTx(tx, {
      userId: actor.userId,
      recipientEmail: user.email!.trim().toLowerCase(),
      organization: org!,
      application: { id: application.id, key: application.key, name: application.name },
      plan: { id: plan.id, key: plan.key, name: plan.name, priceMinor: plan.priceMinor!, currency: plan.currency!, periodDays: plan.periodDays! },
      terms: { id: terms.id, key: terms.key, version: terms.version, title: terms.title, body: terms.body, bodySha256: terms.bodySha256 },
      validUntil,
      idempotencyKey,
      requestId: actor.requestId,
    });
    return { ...created, priceMinor: plan.priceMinor!.toString(), currency: plan.currency!, periodDays: plan.periodDays!, validUntil: validUntil.toISOString() };
  });
  try {
    return { ...(await contract()), replayed: false };
  } catch (error) {
    // A concurrent request with the same key won the unique index (proposals_request_idempotency_unique): answer as its replay.
    if (!isUniqueViolationError(error)) throw error;
    const raced = await replayOf(actor.userId, idempotencyKey);
    if (raced && raced.organizationId === organizationId && raced.applicationKey === input.applicationKey && raced.planKey === input.planKey) return { ...raced.result, replayed: true };
    throw new ConflictError("This Idempotency-Key was already used for a different contracting");
  }
}

async function replayOf(userId: string, idempotencyKey: string) {
  const [row] = await db
    .select({ proposal: proposals, version: proposalVersions })
    .from(proposals)
    .innerJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId))
    .where(and(eq(proposals.createdBy, userId), eq(proposals.requestIdempotencyKey, idempotencyKey)))
    .limit(1);
  if (!row) return null;
  const snapshot = row.version.snapshot as { options: Array<{ id: string; totalMinor: string; items: Array<{ application: { key: string } | null; plan: { key: string } | null; durationDays?: number }> }> } | null;
  const option = snapshot?.options[0];
  const item = option?.items[0];
  return {
    organizationId: row.proposal.organizationId,
    applicationKey: item?.application?.key ?? null,
    planKey: item?.plan?.key ?? null,
    result: {
      proposalId: row.proposal.id,
      versionId: row.version.id,
      optionId: option?.id ?? null,
      contentSha256: row.version.contentSha256,
      priceMinor: option?.totalMinor ?? null,
      currency: row.version.currency,
      periodDays: item?.durationDays ?? null,
      validUntil: row.version.validUntil?.toISOString() ?? null,
    },
  };
}
