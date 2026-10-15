import { and, asc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  applications,
  commercialPayments,
  contractItems,
  contracts,
  contractVersions,
  entitlementGrants,
  organizationApplicationAccess,
  organizations,
  planEntitlements,
  plans,
  subscriptions,
} from "../../db/schema/index.js";
import { AppError, ConflictError, NotFoundError, OrganizationSuspendedError } from "../../shared/errors.js";
import { grantApplicationAccess, revokeApplicationAccess } from "../applicationAccess/service.js";
import { recordAuditEvent } from "../audit/service.js";
import { requestInitialProvisioningInTx } from "../integrationProvisioning/service.js";
import { cancelSubscription, createSubscription } from "../subscriptions/service.js";
import { canonicalize } from "./canonicalJson.js";
import { type CommercialActor, recordCommercialEvent } from "./events.js";
import { contractItemDto, contractSummaryDto, grantDto } from "./serializers.js";

/**
 * Block 1D — contract → entitlement → explicit activation (a UL operation:
 * `platform.entitlement.grant`; clients never activate).
 *
 * Rules:
 *  - only `application_plan` items produce grants (service/support/one_off/
 *    custom never do); at most one per application per contract;
 *  - the contract (version, items, acceptance) is history and never changes;
 *    activation only creates NEW facts (grants, subscription, access) and
 *    moves the contract's status/dates;
 *  - ALL-OR-NOTHING: one transaction; any blocker or failure rolls back;
 *  - never adopts an existing access/subscription (409), never replaces;
 *  - an application_plan needs an explicit duration (no accidental
 *    open-ended subscription); an entitlementSpec must be exactly what the
 *    plan's runtime entitlements provide (no overrides exist yet);
 *  - the tenant ALWAYS comes from the contract, never from the request;
 *  - migration 0023 — NEVER without a confirmed payment of the contract's
 *    exact amount and currency (commercial_payments): the three activation
 *    conditions are organization active + terms accepted and recorded (the
 *    contract only exists from an acceptance) + payment confirmed. Both
 *    channels (assisted and self-service) go through this same function.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type ContractRow = typeof contracts.$inferSelect;

export type ActivationBlockerCode =
  | "CONTRACT_NOT_ACTIVATABLE"
  | "ORGANIZATION_SUSPENDED"
  | "PAYMENT_NOT_CONFIRMED"
  | "DUPLICATE_APPLICATION"
  | "APPLICATION_INACTIVE"
  | "PLAN_INACTIVE"
  | "DURATION_REQUIRED"
  | "ENTITLEMENT_SPEC_UNSUPPORTED"
  | "SUBSCRIPTION_CONFLICT"
  | "APPLICATION_ACCESS_CONFLICT"
  | "GRANT_CONFLICT";

/**
 * Who activates: a platform administrator (the explicit route, or right after
 * they confirm a payment manually), or the platform itself right after an
 * authenticated payment integration confirmed the payment (`apiKeyId`).
 */
export type ActivationActor = CommercialActor | { system: true; apiKeyId: string; requestId?: string };

function actorParts(actor: ActivationActor) {
  return "userId" in actor
    ? { actorType: "platform_admin" as const, actorUserId: actor.userId as string | null, apiKeyId: null as string | null, requestId: actor.requestId }
    : { actorType: "system" as const, actorUserId: null as string | null, apiKeyId: actor.apiKeyId as string | null, requestId: actor.requestId };
}

export interface ActivationBlocker {
  code: ActivationBlockerCode;
  message: string;
  contractItemId?: string;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false; // not representable exactly (e.g. floats) ⇒ never considered equal
  }
}

/** An entitlementSpec is honourable only if every key exists in the plan's runtime entitlements with exactly that value. */
function specSupported(spec: unknown, planValues: Map<string, unknown>): boolean {
  if (spec === null || spec === undefined) return true;
  if (typeof spec !== "object" || Array.isArray(spec)) return false;
  return Object.entries(spec as Record<string, unknown>).every(([key, value]) => planValues.has(key) && sameJson(value, planValues.get(key)));
}

async function loadContract(executor: Executor, contractId: string, lock: boolean): Promise<ContractRow> {
  const query = executor.select().from(contracts).where(eq(contracts.id, contractId));
  const [contract] = lock ? await query.for("update") : await query;
  if (!contract) throw new NotFoundError("Contract not found");
  return contract;
}

/**
 * Read-only analysis shared by the preview and by the activation itself
 * (which runs it inside its transaction, after locking the contract).
 */
async function analyze(executor: Executor, contract: ContractRow) {
  const blockers: ActivationBlocker[] = [];
  if (contract.status !== "pending_activation") blockers.push({ code: "CONTRACT_NOT_ACTIVATABLE", message: `A ${contract.status} contract cannot be activated` });
  const [org] = await executor.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, contract.organizationId));
  if (org?.status !== "active") blockers.push({ code: "ORGANIZATION_SUSPENDED", message: "The contract's organization is not active" });
  const [payment] = await executor
    .select()
    .from(commercialPayments)
    .where(and(eq(commercialPayments.contractId, contract.id), eq(commercialPayments.status, "confirmed")))
    .limit(1);
  if (!payment) blockers.push({ code: "PAYMENT_NOT_CONFIRMED", message: "The contract's payment has not been confirmed" });

  const [version] = contract.currentVersionId ? await executor.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId)) : [];
  if (!version) throw new ConflictError("The contract has no current version");
  const rows = await executor
    .select({ item: contractItems, application: applications, plan: plans })
    .from(contractItems)
    .leftJoin(applications, eq(applications.id, contractItems.applicationId))
    .leftJoin(plans, eq(plans.id, contractItems.planId))
    .where(eq(contractItems.contractVersionId, version.id))
    .orderBy(asc(contractItems.sort), asc(contractItems.createdAt), asc(contractItems.id));

  const eligible = rows.filter((r) => r.item.kind === "application_plan");
  const planIds = eligible.map((r) => r.item.planId!).filter(Boolean);
  const planValueRows = planIds.length ? await executor.select().from(planEntitlements).where(inArray(planEntitlements.planId, planIds)) : [];
  const appCount = new Map<string, number>();
  for (const r of eligible) appCount.set(r.item.applicationId!, (appCount.get(r.item.applicationId!) ?? 0) + 1);

  const items = [];
  for (const { item, application, plan } of rows) {
    const isEligible = item.kind === "application_plan";
    const analysis = {
      contractItemId: item.id,
      kind: item.kind,
      title: item.title,
      eligible: isEligible,
      application: application ? { key: application.key, name: application.name, status: application.status } : null,
      plan: plan ? { key: plan.key, name: plan.name, status: plan.status } : null,
      durationMonths: item.durationMonths,
      durationDays: item.durationDays,
      billingPeriod: item.billingPeriod,
      entitlementSpec: item.entitlementSpec,
      specSupported: null as boolean | null,
      conflicts: { subscription: false, applicationAccess: false, activeGrant: false },
      wouldCreate: { grant: false, subscription: false, applicationAccess: false },
    };
    if (isEligible && application && plan) {
      const push = (code: ActivationBlockerCode, message: string) => blockers.push({ code, message, contractItemId: item.id });
      if ((appCount.get(application.id) ?? 0) > 1) push("DUPLICATE_APPLICATION", `More than one application_plan item for ${application.key}`);
      if (application.status !== "ACTIVE") push("APPLICATION_INACTIVE", `Application ${application.key} is not active`);
      if (plan.status !== "ACTIVE") push("PLAN_INACTIVE", `Plan ${plan.key} is not active`);
      if (item.durationMonths === null && item.durationDays === null) push("DURATION_REQUIRED", `"${item.title}" has no duration: an application_plan needs an explicit durationMonths or durationDays to be activated`);
      const planValues = new Map(planValueRows.filter((v) => v.planId === plan.id).map((v) => [v.key, v.value as unknown]));
      analysis.specSupported = specSupported(item.entitlementSpec, planValues);
      if (!analysis.specSupported) push("ENTITLEMENT_SPEC_UNSUPPORTED", `"${item.title}" promises entitlements plan ${plan.key} does not provide`);
      const [sub] = await executor
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(and(eq(subscriptions.organizationId, contract.organizationId), eq(plans.applicationId, application.id), ne(subscriptions.status, "canceled")))
        .limit(1);
      const [access] = await executor
        .select({ id: organizationApplicationAccess.id })
        .from(organizationApplicationAccess)
        .where(and(eq(organizationApplicationAccess.organizationId, contract.organizationId), eq(organizationApplicationAccess.applicationId, application.id), eq(organizationApplicationAccess.status, "active")))
        .limit(1);
      const [grant] = await executor
        .select({ id: entitlementGrants.id })
        .from(entitlementGrants)
        .where(and(eq(entitlementGrants.organizationId, contract.organizationId), eq(entitlementGrants.applicationId, application.id), eq(entitlementGrants.status, "active")))
        .limit(1);
      analysis.conflicts = { subscription: !!sub, applicationAccess: !!access, activeGrant: !!grant };
      if (sub) push("SUBSCRIPTION_CONFLICT", `The organization already has a non-canceled subscription for ${application.key}`);
      if (access) push("APPLICATION_ACCESS_CONFLICT", `The organization already has active access to ${application.key} not created by this contract`);
      if (grant) push("GRANT_CONFLICT", `The organization already has an active contractual grant for ${application.key}`);
      analysis.wouldCreate = { grant: true, subscription: true, applicationAccess: true };
    }
    items.push(analysis);
  }
  return { version, rows, items, blockers, payment: payment ?? null };
}

export async function getPlatformContract(contractId: string, executor: Executor = db) {
  const contract = await loadContract(executor, contractId, false);
  const [version] = contract.currentVersionId ? await executor.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId)) : [];
  const items = version ? await executor.select().from(contractItems).where(eq(contractItems.contractVersionId, version.id)).orderBy(asc(contractItems.sort), asc(contractItems.createdAt)) : [];
  const grants = await executor.select().from(entitlementGrants).where(eq(entitlementGrants.contractId, contract.id)).orderBy(asc(entitlementGrants.createdAt));
  // Migration 0023 — the confirmed payment, in full for UL administrators (reference, evidence pointer, who confirmed).
  const [payment] = await executor
    .select()
    .from(commercialPayments)
    .where(and(eq(commercialPayments.contractId, contract.id), eq(commercialPayments.status, "confirmed")))
    .limit(1);
  return {
    ...contractSummaryDto(contract, version ?? null),
    items: items.map(contractItemDto),
    grants: grants.map(grantDto),
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          source: payment.source,
          method: payment.method,
          amountMinor: payment.amountMinor.toString(),
          currency: payment.currency,
          externalReference: payment.externalReference,
          evidenceReference: payment.evidenceReference,
          receivedAt: payment.receivedAt.toISOString(),
          confirmedAt: payment.confirmedAt.toISOString(),
          confirmedByUserId: payment.confirmedByUserId,
          confirmedByApiKeyId: payment.confirmedByApiKeyId,
        }
      : null,
  };
}

/** Read-only: what activation would do, and why it would be blocked. No writes, no events. */
export async function previewActivation(contractId: string) {
  const contract = await loadContract(db, contractId, false);
  const { items, blockers, payment } = await analyze(db, contract);
  return {
    contract: { id: contract.id, number: contract.number, status: contract.status, organizationId: contract.organizationId },
    payment: payment ? { id: payment.id, source: payment.source, confirmedAt: payment.confirmedAt.toISOString() } : null,
    activatable: blockers.length === 0,
    blockers,
    items,
  };
}

function blockerError(b: ActivationBlocker): AppError {
  if (b.code === "ORGANIZATION_SUSPENDED") return new OrganizationSuspendedError(b.message);
  return new AppError(409, b.code, b.message);
}

/**
 * Activates a `pending_activation` contract: for every eligible item a grant
 * (planned → active) with its subscription (period = the grant's) and its
 * application access; then the contract becomes `active`. All or nothing.
 * Re-activating an `active` contract returns it unchanged (idempotent).
 */
export async function activateContract(contractId: string, activationActor: ActivationActor) {
  const who = actorParts(activationActor);
  const created = await db.transaction(async (tx: Tx) => {
    const contract = await loadContract(tx, contractId, true);
    if (contract.status === "active") return false;
    const { version, rows, blockers, payment } = await analyze(tx, contract);
    if (blockers.length > 0 || !payment) throw blockerError(blockers[0]!);

    // One timestamp for the whole activation (transaction time), so every grant/subscription/contract shares it.
    const nowRows = (await tx.execute(sql`select now() as now`)) as unknown as Array<{ now: Date | string }>;
    const startsAt = new Date(nowRows[0]!.now);
    const endsAll: Date[] = [];
    const base = { organizationId: contract.organizationId, actorType: who.actorType, actorUserId: who.actorUserId, correlationId: who.requestId };

    for (const { item, application, plan } of rows) {
      if (item.kind !== "application_plan" || !application || !plan) continue;
      // Calendar-correct arithmetic in Postgres (end-of-month safe), never in JS; now() is the transaction time (= startsAt).
      // A period in days (self-service packages: "30 days, not a calendar month") or in calendar months — never both.
      const endRows = (item.durationDays !== null
        ? await tx.execute(sql`select now() + make_interval(days => ${item.durationDays}::int) as ends`)
        : await tx.execute(sql`select now() + make_interval(months => ${item.durationMonths!}::int) as ends`)) as unknown as Array<{ ends: Date | string }>;
      const endsAt = new Date(endRows[0]!.ends);
      endsAll.push(endsAt);
      const [grant] = await tx
        .insert(entitlementGrants)
        .values({
          contractId: contract.id,
          contractItemId: item.id,
          organizationId: contract.organizationId,
          applicationId: application.id,
          planId: plan.id,
          entitlementsSnapshot: {
            schema: "ul.commercial.grant/1",
            contractVersionId: version.id,
            contractContentSha256: version.contentSha256,
            item: {
              title: item.title,
              quantity: item.quantity,
              billingPeriod: item.billingPeriod,
              durationMonths: item.durationMonths,
              ...(item.durationDays !== null ? { durationDays: item.durationDays } : {}),
              unitPriceMinor: item.unitPriceMinor.toString(),
              lineTotalMinor: item.lineTotalMinor.toString(),
              entitlementSpec: item.entitlementSpec ?? null,
            },
          },
          startsAt,
          endsAt,
          status: "planned",
        })
        .returning();
      await recordCommercialEvent(tx, { ...base, aggregateType: "entitlement_grant", aggregateId: grant!.id, eventType: "entitlement.planned", payload: { contractId: contract.id, contractItemId: item.id, applicationKey: application.key, planKey: plan.key } });

      const subscription = await createSubscription(
        { organizationId: contract.organizationId, applicationKey: application.key, planKey: plan.key, actorUserId: who.actorUserId, currentPeriodStart: startsAt, currentPeriodEnd: endsAt },
        tx,
      );
      const access = await grantApplicationAccess({ organizationId: contract.organizationId, applicationKey: application.key, actorUserId: who.actorUserId }, tx);
      await tx
        .update(entitlementGrants)
        .set({ status: "active", activatedAt: startsAt, activatedBy: who.actorUserId, activatedByApiKeyId: who.apiKeyId, subscriptionId: subscription.id, applicationAccessId: access.id, updatedAt: sql`now()` })
        .where(eq(entitlementGrants.id, grant!.id));
      // D2-B — an application with a managed integration (Na Pista) gets its provisioning request in the same transaction.
      await requestInitialProvisioningInTx(tx, {
        organizationId: contract.organizationId,
        applicationId: application.id,
        applicationKey: application.key,
        contractId: contract.id,
        entitlementGrantId: grant!.id,
        actorUserId: who.actorUserId,
      });
      await recordCommercialEvent(tx, {
        ...base,
        aggregateType: "entitlement_grant",
        aggregateId: grant!.id,
        eventType: "entitlement.activated",
        payload: { contractId: contract.id, applicationKey: application.key, planKey: plan.key, subscriptionId: subscription.id, applicationAccessId: access.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      });
    }

    const endsAt = endsAll.length ? new Date(Math.max(...endsAll.map((d) => d.getTime()))) : null;
    await tx.update(contracts).set({ status: "active", startsAt, endsAt, updatedAt: sql`now()` }).where(eq(contracts.id, contract.id));
    await recordCommercialEvent(tx, {
      ...base,
      aggregateType: "contract",
      aggregateId: contract.id,
      eventType: "contract.activated",
      idempotencyKey: `contract.activated:${contract.id}`,
      payload: { number: contract.number, grants: endsAll.length, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, paymentId: payment.id, ...(who.apiKeyId ? { apiKeyId: who.apiKeyId } : {}) },
    });
    await recordAuditEvent(
      { actorUserId: who.actorUserId ?? undefined, organizationId: contract.organizationId, action: "platform.commercial.contract.activated", targetType: "contract", targetId: contract.id, metadata: { number: contract.number, grants: endsAll.length, paymentId: payment.id, actor: who.actorType, ...(who.apiKeyId ? { apiKeyId: who.apiKeyId } : {}) } },
      tx,
    );
    return true;
  });
  return { created, contract: await getPlatformContract(contractId) };
}

/** Revokes one grant inside the caller's transaction: grant → revoked, its subscription canceled, its access revoked unless another active grant still backs it. */
async function revokeGrantInTx(tx: Tx, grant: typeof entitlementGrants.$inferSelect, reason: string, actor: CommercialActor) {
  if (grant.status === "active") {
    if (grant.subscriptionId) {
      const [sub] = await tx.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.id, grant.subscriptionId));
      if (sub && sub.status !== "canceled") await cancelSubscription({ organizationId: grant.organizationId, subscriptionId: grant.subscriptionId, actorUserId: actor.userId }, tx);
    }
    if (grant.applicationAccessId) {
      const [access] = await tx.select({ status: organizationApplicationAccess.status }).from(organizationApplicationAccess).where(eq(organizationApplicationAccess.id, grant.applicationAccessId));
      const [otherBacking] = await tx
        .select({ id: entitlementGrants.id })
        .from(entitlementGrants)
        .where(and(eq(entitlementGrants.applicationAccessId, grant.applicationAccessId), eq(entitlementGrants.status, "active"), ne(entitlementGrants.id, grant.id)))
        .limit(1);
      if (access?.status === "active" && !otherBacking) {
        const [application] = await tx.select({ key: applications.key }).from(applications).where(eq(applications.id, grant.applicationId));
        await revokeApplicationAccess({ organizationId: grant.organizationId, applicationKey: application!.key, actorUserId: actor.userId }, tx);
      }
    }
  }
  await tx
    .update(entitlementGrants)
    .set({ status: "revoked", revokedAt: sql`now()`, revokedBy: actor.userId, revokeReason: reason, updatedAt: sql`now()` })
    .where(eq(entitlementGrants.id, grant.id));
  await recordCommercialEvent(tx, {
    aggregateType: "entitlement_grant",
    aggregateId: grant.id,
    eventType: "entitlement.revoked",
    organizationId: grant.organizationId,
    actorType: "platform_admin",
    actorUserId: actor.userId,
    correlationId: actor.requestId,
    idempotencyKey: `entitlement.revoked:${grant.id}`,
    payload: { contractId: grant.contractId, previousStatus: grant.status, reason, subscriptionId: grant.subscriptionId, applicationAccessId: grant.applicationAccessId },
  });
  await recordAuditEvent(
    { actorUserId: actor.userId, organizationId: grant.organizationId, action: "platform.commercial.entitlement.revoked", targetType: "entitlement_grant", targetId: grant.id, metadata: { contractId: grant.contractId, reason } },
    tx,
  );
}

/** Revocation is final and idempotent; an expired grant cannot be revoked (409). The contract status does not change. */
export async function revokeGrant(grantId: string, reason: string, actor: CommercialActor) {
  const grant = await db.transaction(async (tx: Tx) => {
    const [row] = await tx.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId)).for("update");
    if (!row) throw new NotFoundError("Entitlement grant not found");
    if (row.status === "revoked") return row;
    if (row.status === "expired") throw new ConflictError("An expired grant cannot be revoked");
    await revokeGrantInTx(tx, row, reason, actor);
    const [updated] = await tx.select().from(entitlementGrants).where(eq(entitlementGrants.id, grantId));
    return updated!;
  });
  return grantDto(grant);
}

/** pending_activation → cancelled (nothing was activated). Idempotent. */
export async function cancelContract(contractId: string, actor: CommercialActor) {
  await db.transaction(async (tx: Tx) => {
    const contract = await loadContract(tx, contractId, true);
    if (contract.status === "cancelled") return;
    if (contract.status !== "pending_activation") throw new AppError(409, "CONTRACT_NOT_CANCELLABLE", `A ${contract.status} contract cannot be cancelled`);
    for (const grant of await tx.select().from(entitlementGrants).where(and(eq(entitlementGrants.contractId, contract.id), inArray(entitlementGrants.status, ["planned", "active"]))).for("update")) {
      await revokeGrantInTx(tx, grant, "contract cancelled", actor);
    }
    await tx.update(contracts).set({ status: "cancelled", updatedAt: sql`now()` }).where(eq(contracts.id, contract.id));
    await recordCommercialEvent(tx, { aggregateType: "contract", aggregateId: contract.id, eventType: "contract.cancelled", organizationId: contract.organizationId, actorType: "platform_admin", actorUserId: actor.userId, correlationId: actor.requestId, idempotencyKey: `contract.cancelled:${contract.id}`, payload: { number: contract.number } });
    await recordAuditEvent({ actorUserId: actor.userId, organizationId: contract.organizationId, action: "platform.commercial.contract.cancelled", targetType: "contract", targetId: contract.id, metadata: { number: contract.number } }, tx);
  });
  return getPlatformContract(contractId);
}

/** active → terminated, revoking every planned/active grant of the contract in the same transaction. Idempotent. */
export async function terminateContract(contractId: string, actor: CommercialActor) {
  await db.transaction(async (tx: Tx) => {
    const contract = await loadContract(tx, contractId, true);
    if (contract.status === "terminated") return;
    if (contract.status !== "active") throw new AppError(409, "CONTRACT_NOT_TERMINABLE", `A ${contract.status} contract cannot be terminated`);
    const grants = await tx.select().from(entitlementGrants).where(and(eq(entitlementGrants.contractId, contract.id), inArray(entitlementGrants.status, ["planned", "active"]))).for("update");
    for (const grant of grants) await revokeGrantInTx(tx, grant, "contract terminated", actor);
    await tx.update(contracts).set({ status: "terminated", updatedAt: sql`now()` }).where(eq(contracts.id, contract.id));
    await recordCommercialEvent(tx, { aggregateType: "contract", aggregateId: contract.id, eventType: "contract.terminated", organizationId: contract.organizationId, actorType: "platform_admin", actorUserId: actor.userId, correlationId: actor.requestId, idempotencyKey: `contract.terminated:${contract.id}`, payload: { number: contract.number, revokedGrants: grants.map((g) => g.id) } });
    await recordAuditEvent({ actorUserId: actor.userId, organizationId: contract.organizationId, action: "platform.commercial.contract.terminated", targetType: "contract", targetId: contract.id, metadata: { number: contract.number, revokedGrants: grants.length } }, tx);
  });
  return getPlatformContract(contractId);
}

/** Block 1D — a subscription backed by an ACTIVE contractual grant is managed by the contract, not by self-service. */
export async function isContractManagedSubscription(organizationId: string, subscriptionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: entitlementGrants.id })
    .from(entitlementGrants)
    .where(and(eq(entitlementGrants.organizationId, organizationId), eq(entitlementGrants.subscriptionId, subscriptionId), eq(entitlementGrants.status, "active")))
    .limit(1);
  return !!row;
}

/**
 * Persists what read-time effectiveness already enforces (entitlements/effectiveness.ts): every ACTIVE
 * contract whose period ended becomes `expired`, its due grants `expired` (active → expired), their
 * subscriptions canceled and their application access revoked unless another active grant still backs it.
 * One transaction per contract (row-locked, re-checked), so it is safe to run from several workers and to
 * re-run (idempotent). Actor: the platform itself (system). Run by the worker (src/worker.ts).
 */
export async function expireDueContracts(limit = 100): Promise<{ expired: string[] }> {
  const due = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(and(eq(contracts.status, "active"), isNotNull(contracts.endsAt), lte(contracts.endsAt, sql`now()`)))
    .limit(limit);
  const expired: string[] = [];
  for (const { id } of due) {
    const done = await db.transaction(async (tx: Tx) => {
      const [contract] = await tx.select().from(contracts).where(eq(contracts.id, id)).for("update", { skipLocked: true });
      if (!contract || contract.status !== "active" || !contract.endsAt || contract.endsAt.getTime() > Date.now()) return false;
      const grants = await tx
        .select()
        .from(entitlementGrants)
        .where(and(eq(entitlementGrants.contractId, contract.id), eq(entitlementGrants.status, "active"), lte(entitlementGrants.endsAt, sql`now()`)))
        .for("update");
      for (const grant of grants) {
        if (grant.subscriptionId) {
          const [sub] = await tx.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.id, grant.subscriptionId));
          if (sub && sub.status !== "canceled") await cancelSubscription({ organizationId: grant.organizationId, subscriptionId: grant.subscriptionId, actorUserId: null }, tx);
        }
        if (grant.applicationAccessId) {
          const [access] = await tx.select({ status: organizationApplicationAccess.status }).from(organizationApplicationAccess).where(eq(organizationApplicationAccess.id, grant.applicationAccessId));
          const [otherBacking] = await tx
            .select({ id: entitlementGrants.id })
            .from(entitlementGrants)
            .where(and(eq(entitlementGrants.applicationAccessId, grant.applicationAccessId), eq(entitlementGrants.status, "active"), ne(entitlementGrants.id, grant.id)))
            .limit(1);
          if (access?.status === "active" && !otherBacking) {
            const [application] = await tx.select({ key: applications.key }).from(applications).where(eq(applications.id, grant.applicationId));
            await revokeApplicationAccess({ organizationId: grant.organizationId, applicationKey: application!.key, actorUserId: null }, tx);
          }
        }
        await tx.update(entitlementGrants).set({ status: "expired", updatedAt: sql`now()` }).where(eq(entitlementGrants.id, grant.id));
        await recordCommercialEvent(tx, {
          aggregateType: "entitlement_grant",
          aggregateId: grant.id,
          eventType: "entitlement.expired",
          organizationId: grant.organizationId,
          actorType: "system",
          idempotencyKey: `entitlement.expired:${grant.id}`,
          payload: { contractId: grant.contractId, endsAt: grant.endsAt?.toISOString() ?? null, subscriptionId: grant.subscriptionId, applicationAccessId: grant.applicationAccessId },
        });
      }
      await tx.update(contracts).set({ status: "expired", updatedAt: sql`now()` }).where(eq(contracts.id, contract.id));
      await recordCommercialEvent(tx, {
        aggregateType: "contract",
        aggregateId: contract.id,
        eventType: "contract.expired",
        organizationId: contract.organizationId,
        actorType: "system",
        idempotencyKey: `contract.expired:${contract.id}`,
        payload: { number: contract.number, endsAt: contract.endsAt.toISOString(), expiredGrants: grants.map((g) => g.id) },
      });
      await recordAuditEvent(
        { organizationId: contract.organizationId, action: "platform.commercial.contract.expired", targetType: "contract", targetId: contract.id, metadata: { number: contract.number, expiredGrants: grants.length } },
        tx,
      );
      return true;
    });
    if (done) expired.push(id);
  }
  return { expired };
}
