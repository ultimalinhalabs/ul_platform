import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import {
  commercialPayments,
  contractItems,
  contractRenewalAuthorizations,
  contractRenewals,
  contracts,
  entitlementGrants,
  organizations,
  subscriptions,
} from "../../db/schema/index.js";
import { AppError, ConflictError, NotFoundError, OrganizationSuspendedError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { enqueueEmail } from "../email/outbox.js";
import { formatMoney, renewalCreatedEmail } from "../email/templates.js";
import { recordCommercialEvent } from "./events.js";
import { clientContractUrl, ownerEmails, paymentMethodsConfigured, renewalReference } from "./notify.js";

/**
 * Migration 0026 — renewal with manual payment confirmation (spec §6.2, A7/B8, T11–T13).
 *
 *  - An OWNER authorizes renewal expressly: the server shows the exact text (price, period, how renewal works and
 *    how to withdraw) and records it with its hash. It never becomes recurring billing.
 *  - While the authorization stands, the next period is prepared `awaiting_payment` RENEWAL_LEAD_DAYS before the
 *    current one ends (worker, or at once if already inside that window) — T11. The owners get an email with the
 *    payment instructions.
 *  - Its confirmed payment applies it exactly once: the contract, its active grants and their subscriptions end
 *    `period_days` later — T12. Applying needs the organization active (like activation).
 *  - Withdrawing stops future renewals and cancels an unpaid prepared one — T13.
 *  - Unpaid when the current period ends: the renewal lapses and access ends with the period (expiry sweep).
 * Renewable contracts: active, with exactly one application_plan item whose period is in days (the self-service
 * packages). The renewal price is that item's line total, at the contracted price.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type ContractRow = typeof contracts.$inferSelect;
type RenewalRow = typeof contractRenewals.$inferSelect;
type AuthorizationRow = typeof contractRenewalAuthorizations.$inferSelect;

export const authorizeRenewalSchema = z.object({ consent: z.literal(true), consentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The authorization text (v1). PENDING LEGAL VALIDATION (spec §6.2: validate authorization, notices, withdrawal
 * period and failed payments before using it with clients) — changing it changes the hash, never past records.
 */
export function renewalConsentText(input: { planTitle: string; periodDays: number; amountMinor: bigint; currency: string; leadDays: number }): string {
  return (
    `Autorizo a renovação do plano "${input.planTitle}" desta organização por períodos sucessivos de ${input.periodDays} dias, ` +
    `pelo valor de ${formatMoney(input.amountMinor, input.currency)} por período. ` +
    `Compreendo que a renovação não é uma cobrança automática: ${input.leadDays} dias antes do fim de cada período a Última Linha prepara o período seguinte com pagamento pendente, ` +
    `que só fica ativo depois de o pagamento ser confirmado; sem pagamento confirmado até ao fim do período em curso, o acesso termina nessa data. ` +
    `Posso retirar esta autorização a qualquer momento na página do contrato; uma renovação já preparada e ainda não paga é então cancelada.`
  );
}

export interface RenewalTerms {
  eligible: boolean;
  reason: string | null;
  planTitle: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  periodDays: number | null;
}

export async function renewalTerms(executor: Executor, contract: ContractRow): Promise<RenewalTerms> {
  const none = (reason: string): RenewalTerms => ({ eligible: false, reason, planTitle: null, amountMinor: null, currency: null, periodDays: null });
  if (!contract.currentVersionId) return none("NO_VERSION");
  const items = await executor.select().from(contractItems).where(and(eq(contractItems.contractVersionId, contract.currentVersionId), eq(contractItems.kind, "application_plan")));
  if (items.length !== 1) return none("NOT_A_SINGLE_PLAN");
  const item = items[0]!;
  if (item.durationDays === null) return none("PERIOD_NOT_IN_DAYS");
  const terms = { planTitle: item.title, amountMinor: item.lineTotalMinor, currency: contract.currency, periodDays: item.durationDays };
  if (contract.status !== "active") return { eligible: false, reason: "CONTRACT_NOT_ACTIVE", ...terms };
  return { eligible: true, reason: null, ...terms };
}

function authorizationDto(row: AuthorizationRow) {
  return {
    id: row.id,
    contractId: row.contractId,
    authorizedByUserId: row.authorizedByUserId,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    periodDays: row.periodDays,
    consentText: row.consentText,
    consentSha256: row.consentSha256,
    authorizedAt: row.authorizedAt.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    withdrawnByUserId: row.withdrawnByUserId,
  };
}

export function renewalDto(row: RenewalRow, contractNumber: string) {
  return {
    id: row.id,
    contractId: row.contractId,
    sequence: row.sequence,
    reference: renewalReference(contractNumber, row.sequence),
    status: row.status,
    periodStartsAt: row.periodStartsAt.toISOString(),
    periodEndsAt: row.periodEndsAt.toISOString(),
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    lapsedAt: row.lapsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Everything about renewal for one contract, as both the client and the platform see it. */
export async function renewalState(executor: Executor, contract: ContractRow) {
  const terms = await renewalTerms(executor, contract);
  const [standing] = await executor
    .select()
    .from(contractRenewalAuthorizations)
    .where(and(eq(contractRenewalAuthorizations.contractId, contract.id), isNull(contractRenewalAuthorizations.withdrawnAt)))
    .limit(1);
  const renewals = await executor.select().from(contractRenewals).where(eq(contractRenewals.contractId, contract.id)).orderBy(desc(contractRenewals.sequence));
  const offer =
    terms.eligible && !standing
      ? (() => {
          const text = renewalConsentText({ planTitle: terms.planTitle!, periodDays: terms.periodDays!, amountMinor: terms.amountMinor!, currency: terms.currency!, leadDays: env.RENEWAL_LEAD_DAYS });
          return { consentText: text, consentSha256: sha(text), amountMinor: terms.amountMinor!.toString(), currency: terms.currency!, periodDays: terms.periodDays!, leadDays: env.RENEWAL_LEAD_DAYS };
        })()
      : null;
  return {
    eligible: terms.eligible,
    ineligibleReason: terms.reason,
    leadDays: env.RENEWAL_LEAD_DAYS,
    authorization: standing ? authorizationDto(standing) : null,
    offer,
    renewals: renewals.map((r) => renewalDto(r, contract.number)),
  };
}

async function loadOrgContract(tx: Tx, organizationId: string, contractId: string): Promise<ContractRow> {
  const [contract] = await tx.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.organizationId, organizationId))).for("update");
  if (!contract) throw new NotFoundError("Contract not found");
  return contract;
}

export async function authorizeRenewal(
  organizationId: string,
  contractId: string,
  input: z.infer<typeof authorizeRenewalSchema>,
  idempotencyKey: string,
  actor: { userId: string; requestId?: string },
) {
  const result = await db.transaction(async (tx) => {
    const [byKey] = await tx.select().from(contractRenewalAuthorizations).where(eq(contractRenewalAuthorizations.idempotencyKey, idempotencyKey)).limit(1);
    if (byKey) {
      if (byKey.contractId === contractId && byKey.organizationId === organizationId && byKey.authorizedByUserId === actor.userId && byKey.consentSha256 === input.consentSha256) return { row: byKey, created: false };
      throw new ConflictError("This Idempotency-Key was already used for a different authorization");
    }
    const contract = await loadOrgContract(tx, organizationId, contractId);
    const terms = await renewalTerms(tx, contract);
    if (!terms.eligible) throw new AppError(409, "RENEWAL_NOT_AVAILABLE", `This contract cannot be renewed (${terms.reason})`);
    const text = renewalConsentText({ planTitle: terms.planTitle!, periodDays: terms.periodDays!, amountMinor: terms.amountMinor!, currency: terms.currency!, leadDays: env.RENEWAL_LEAD_DAYS });
    // The person must have been shown exactly this text (same as the acceptance's content hash).
    if (sha(text) !== input.consentSha256) throw new AppError(409, "CONSENT_OUTDATED", "The renewal terms changed; review them again");
    const [standing] = await tx.select().from(contractRenewalAuthorizations).where(and(eq(contractRenewalAuthorizations.contractId, contract.id), isNull(contractRenewalAuthorizations.withdrawnAt))).limit(1);
    if (standing) throw new AppError(409, "RENEWAL_ALREADY_AUTHORIZED", "Renewal is already authorized for this contract");
    const [row] = await tx
      .insert(contractRenewalAuthorizations)
      .values({ contractId: contract.id, organizationId, authorizedByUserId: actor.userId, amountMinor: terms.amountMinor!, currency: terms.currency!, periodDays: terms.periodDays!, consentText: text, consentSha256: sha(text), idempotencyKey })
      .returning();
    await recordCommercialEvent(tx, {
      aggregateType: "contract",
      aggregateId: contract.id,
      eventType: "contract.renewal.authorized",
      organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      idempotencyKey: `contract.renewal.authorized:${row!.id}`,
      payload: { authorizationId: row!.id, amountMinor: terms.amountMinor!.toString(), currency: terms.currency, periodDays: terms.periodDays, consentSha256: row!.consentSha256 },
    });
    await recordAuditEvent({ actorUserId: actor.userId, organizationId, action: "commercial.contract.renewal.authorized", targetType: "contract", targetId: contract.id, metadata: { authorizationId: row!.id } }, tx);
    return { row: row!, created: true };
  });
  // Already inside the lead window: prepare the renewal now rather than at the next sweep.
  if (result.created) await prepareRenewalForContract(contractId);
  return { authorization: authorizationDto(result.row), created: result.created };
}

export async function withdrawRenewalAuthorization(organizationId: string, contractId: string, actor: { userId: string; requestId?: string }) {
  return db.transaction(async (tx) => {
    const contract = await loadOrgContract(tx, organizationId, contractId);
    const [standing] = await tx.select().from(contractRenewalAuthorizations).where(and(eq(contractRenewalAuthorizations.contractId, contract.id), isNull(contractRenewalAuthorizations.withdrawnAt))).for("update");
    if (!standing) return { withdrawn: false, cancelledRenewalId: null as string | null };
    await tx.update(contractRenewalAuthorizations).set({ withdrawnAt: sql`now()`, withdrawnByUserId: actor.userId, updatedAt: sql`now()` }).where(eq(contractRenewalAuthorizations.id, standing.id));
    const [awaiting] = await tx.select().from(contractRenewals).where(and(eq(contractRenewals.contractId, contract.id), eq(contractRenewals.status, "awaiting_payment"))).for("update");
    let cancelledRenewalId: string | null = null;
    if (awaiting) {
      const [paid] = await tx.select({ id: commercialPayments.id }).from(commercialPayments).where(and(eq(commercialPayments.renewalId, awaiting.id), eq(commercialPayments.status, "confirmed"))).limit(1);
      // A renewal already paid (but not yet applied, e.g. organization suspended) is not cancelled by a withdrawal.
      if (!paid) {
        await tx.update(contractRenewals).set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` }).where(eq(contractRenewals.id, awaiting.id));
        cancelledRenewalId = awaiting.id;
        await recordCommercialEvent(tx, { aggregateType: "contract_renewal", aggregateId: awaiting.id, eventType: "contract.renewal.cancelled", organizationId, actorType: "user", actorUserId: actor.userId, correlationId: actor.requestId, idempotencyKey: `contract.renewal.cancelled:${awaiting.id}`, payload: { contractId: contract.id, reason: "authorization withdrawn" } });
      }
    }
    await recordCommercialEvent(tx, { aggregateType: "contract", aggregateId: contract.id, eventType: "contract.renewal.withdrawn", organizationId, actorType: "user", actorUserId: actor.userId, correlationId: actor.requestId, idempotencyKey: `contract.renewal.withdrawn:${standing.id}`, payload: { authorizationId: standing.id, cancelledRenewalId } });
    await recordAuditEvent({ actorUserId: actor.userId, organizationId, action: "commercial.contract.renewal.withdrawn", targetType: "contract", targetId: contract.id, metadata: { authorizationId: standing.id, cancelledRenewalId } }, tx);
    return { withdrawn: true, cancelledRenewalId };
  });
}

/**
 * Prepares the next period of ONE contract when due (standing authorization, active, inside the lead window, not
 * already prepared for this period). Row-locked (SKIP LOCKED) and re-checked: safe from several workers and from
 * the authorization request at the same time. Returns the created renewal id, or null.
 */
export async function prepareRenewalForContract(contractId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update", { skipLocked: true });
    if (!contract || contract.status !== "active" || !contract.endsAt) return null;
    const leadRows = (await tx.execute(sql`select (${contract.endsAt.toISOString()}::timestamptz - make_interval(days => ${env.RENEWAL_LEAD_DAYS}::int)) <= now() as due, ${contract.endsAt.toISOString()}::timestamptz > now() as running`)) as unknown as Array<{ due: boolean; running: boolean }>;
    if (!leadRows[0]!.due || !leadRows[0]!.running) return null;
    const [standing] = await tx.select().from(contractRenewalAuthorizations).where(and(eq(contractRenewalAuthorizations.contractId, contract.id), isNull(contractRenewalAuthorizations.withdrawnAt))).limit(1);
    if (!standing) return null; // T13 — withdrawn (or never given): no renewal
    const [existing] = await tx.select({ id: contractRenewals.id }).from(contractRenewals).where(and(eq(contractRenewals.contractId, contract.id), eq(contractRenewals.periodStartsAt, contract.endsAt))).limit(1);
    if (existing) return null;
    const terms = await renewalTerms(tx, contract);
    // The authorization covers exactly these terms; anything else is never renewed silently.
    if (!terms.eligible || terms.amountMinor !== standing.amountMinor || terms.currency !== standing.currency || terms.periodDays !== standing.periodDays) return null;
    const [{ last }] = (await tx.select({ last: max(contractRenewals.sequence) }).from(contractRenewals).where(eq(contractRenewals.contractId, contract.id))) as [{ last: number | null }];
    const sequence = (last ?? 0) + 1;
    const endRows = (await tx.execute(sql`select ${contract.endsAt.toISOString()}::timestamptz + make_interval(days => ${standing.periodDays}::int) as ends`)) as unknown as Array<{ ends: Date | string }>;
    const [renewal] = await tx
      .insert(contractRenewals)
      .values({ contractId: contract.id, organizationId: contract.organizationId, authorizationId: standing.id, sequence, periodStartsAt: contract.endsAt, periodEndsAt: new Date(endRows[0]!.ends), amountMinor: standing.amountMinor, currency: standing.currency })
      .returning();
    await recordCommercialEvent(tx, {
      aggregateType: "contract_renewal",
      aggregateId: renewal!.id,
      eventType: "contract.renewal.created",
      organizationId: contract.organizationId,
      actorType: "system",
      idempotencyKey: `contract.renewal.created:${renewal!.id}`,
      payload: { contractId: contract.id, sequence, authorizationId: standing.id, periodStartsAt: renewal!.periodStartsAt.toISOString(), periodEndsAt: renewal!.periodEndsAt.toISOString(), amountMinor: renewal!.amountMinor.toString(), currency: renewal!.currency },
    });
    await recordAuditEvent({ organizationId: contract.organizationId, action: "commercial.contract.renewal.created", targetType: "contract", targetId: contract.id, metadata: { renewalId: renewal!.id, sequence } }, tx);
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, contract.organizationId));
    for (const to of await ownerEmails(tx, contract.organizationId)) {
      await enqueueEmail(tx, {
        kind: "commercial.contract.renewal.created",
        to,
        dedupeKey: `commercial.contract.renewal.created:${renewal!.id}:${to}`,
        ...renewalCreatedEmail({
          organizationName: org!.name,
          contractNumber: contract.number,
          reference: renewalReference(contract.number, sequence),
          amountMinor: renewal!.amountMinor,
          currency: renewal!.currency,
          periodStartsAt: renewal!.periodStartsAt,
          periodEndsAt: renewal!.periodEndsAt,
          instructions: paymentMethodsConfigured(),
          contractUrl: clientContractUrl(contract.organizationId, contract.id),
        }),
      });
    }
    return renewal!.id;
  });
}

/** Worker sweep: every active contract with a standing authorization whose period ends within the lead window. */
export async function prepareDueRenewals(limit = 100): Promise<{ created: string[] }> {
  const candidates = await db
    .selectDistinct({ id: contracts.id })
    .from(contracts)
    .innerJoin(contractRenewalAuthorizations, and(eq(contractRenewalAuthorizations.contractId, contracts.id), isNull(contractRenewalAuthorizations.withdrawnAt)))
    .where(and(eq(contracts.status, "active"), gt(contracts.endsAt, sql`now()`), lte(contracts.endsAt, sql`now() + make_interval(days => ${env.RENEWAL_LEAD_DAYS}::int)`)))
    .limit(limit);
  const created: string[] = [];
  for (const { id } of candidates) {
    const renewalId = await prepareRenewalForContract(id);
    if (renewalId) created.push(renewalId);
  }
  return { created };
}

export type RenewalActor = { userId: string; requestId?: string } | { system: true; apiKeyId: string; requestId?: string };

/**
 * Applies a PAID renewal exactly once (T12): renewal → active; the contract, its active grants and their
 * subscriptions end at the renewal's period end. Needs: renewal awaiting payment with a confirmed payment, contract
 * active and still ending where the renewal starts, organization active. Re-applying returns `applied: false`.
 */
export async function applyRenewal(renewalId: string, actor: RenewalActor) {
  const actorUserId = "userId" in actor ? actor.userId : null;
  return db.transaction(async (tx) => {
    const [ref] = await tx.select({ contractId: contractRenewals.contractId }).from(contractRenewals).where(eq(contractRenewals.id, renewalId));
    if (!ref) throw new NotFoundError("Renewal not found");
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, ref.contractId)).for("update");
    const [renewal] = await tx.select().from(contractRenewals).where(eq(contractRenewals.id, renewalId)).for("update");
    if (renewal!.status === "active") return { applied: false, renewal: renewalDto(renewal!, contract!.number) };
    if (renewal!.status !== "awaiting_payment") throw new AppError(409, "RENEWAL_NOT_APPLICABLE", `A ${renewal!.status} renewal cannot be applied`);
    const [payment] = await tx.select().from(commercialPayments).where(and(eq(commercialPayments.renewalId, renewalId), eq(commercialPayments.status, "confirmed"))).limit(1);
    if (!payment) throw new AppError(409, "PAYMENT_NOT_CONFIRMED", "The renewal's payment has not been confirmed");
    if (contract!.status !== "active" || !contract!.endsAt || contract!.endsAt.getTime() !== renewal!.periodStartsAt.getTime()) {
      throw new AppError(409, "RENEWAL_NOT_APPLICABLE", "The contract is no longer in the period this renewal continues");
    }
    const [org] = await tx.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, contract!.organizationId));
    if (org?.status !== "active") throw new OrganizationSuspendedError("The contract's organization is not active");

    const grants = await tx
      .select()
      .from(entitlementGrants)
      .where(and(eq(entitlementGrants.contractId, contract!.id), eq(entitlementGrants.status, "active")))
      .for("update");
    for (const grant of grants) {
      await tx.update(entitlementGrants).set({ endsAt: renewal!.periodEndsAt, updatedAt: sql`now()` }).where(eq(entitlementGrants.id, grant.id));
      if (grant.subscriptionId) await tx.update(subscriptions).set({ currentPeriodEnd: renewal!.periodEndsAt, updatedAt: sql`now()` }).where(eq(subscriptions.id, grant.subscriptionId));
    }
    await tx.update(contracts).set({ endsAt: renewal!.periodEndsAt, updatedAt: sql`now()` }).where(eq(contracts.id, contract!.id));
    const [applied] = await tx.update(contractRenewals).set({ status: "active", appliedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(contractRenewals.id, renewalId)).returning();
    await recordCommercialEvent(tx, {
      aggregateType: "contract_renewal",
      aggregateId: renewalId,
      eventType: "contract.renewal.activated",
      organizationId: contract!.organizationId,
      actorType: actorUserId ? "platform_admin" : "system",
      actorUserId,
      correlationId: actor.requestId,
      idempotencyKey: `contract.renewal.activated:${renewalId}`,
      payload: { contractId: contract!.id, paymentId: payment.id, sequence: renewal!.sequence, periodEndsAt: renewal!.periodEndsAt.toISOString(), grants: grants.map((g) => g.id), ...("apiKeyId" in actor ? { apiKeyId: actor.apiKeyId } : {}) },
    });
    await recordAuditEvent({ actorUserId: actorUserId ?? undefined, organizationId: contract!.organizationId, action: "platform.commercial.contract.renewal.activated", targetType: "contract", targetId: contract!.id, metadata: { renewalId, paymentId: payment.id, sequence: renewal!.sequence } }, tx);
    return { applied: true, renewal: renewalDto(applied!, contract!.number) };
  });
}

/** Expiry sweep (same transaction as the contract's expiry): renewals still awaiting payment when the period ended lapse. */
export async function lapseRenewalsInTx(tx: Tx, contractId: string, organizationId: string) {
  const lapsed = await tx
    .update(contractRenewals)
    .set({ status: "lapsed", lapsedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(contractRenewals.contractId, contractId), eq(contractRenewals.status, "awaiting_payment"), lte(contractRenewals.periodStartsAt, sql`now()`)))
    .returning({ id: contractRenewals.id });
  for (const { id } of lapsed) {
    await recordCommercialEvent(tx, { aggregateType: "contract_renewal", aggregateId: id, eventType: "contract.renewal.lapsed", organizationId, actorType: "system", idempotencyKey: `contract.renewal.lapsed:${id}`, payload: { contractId } });
  }
  return lapsed.length;
}

/** Termination/cancellation: an unpaid prepared renewal of that contract is cancelled. */
export async function cancelAwaitingRenewalsInTx(tx: Tx, contractId: string, organizationId: string, reason: string, actorUserId: string | null) {
  const cancelled = await tx
    .update(contractRenewals)
    .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(contractRenewals.contractId, contractId), eq(contractRenewals.status, "awaiting_payment")))
    .returning({ id: contractRenewals.id });
  for (const { id } of cancelled) {
    await recordCommercialEvent(tx, { aggregateType: "contract_renewal", aggregateId: id, eventType: "contract.renewal.cancelled", organizationId, actorType: actorUserId ? "platform_admin" : "system", actorUserId, idempotencyKey: `contract.renewal.cancelled:${id}`, payload: { contractId, reason } });
  }
}

/** Platform: the renewals awaiting payment (an operations view), soonest due first. */
export async function listAwaitingRenewals() {
  const rows = await db
    .select({ renewal: contractRenewals, number: contracts.number, organizationName: organizations.name })
    .from(contractRenewals)
    .innerJoin(contracts, eq(contracts.id, contractRenewals.contractId))
    .innerJoin(organizations, eq(organizations.id, contractRenewals.organizationId))
    .where(inArray(contractRenewals.status, ["awaiting_payment"]))
    .orderBy(asc(contractRenewals.periodStartsAt))
    .limit(200);
  return rows.map((r) => ({ ...renewalDto(r.renewal, r.number), organizationId: r.renewal.organizationId, organizationName: r.organizationName, contractNumber: r.number }));
}
