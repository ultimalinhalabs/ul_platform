import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { commercialPayments, contracts } from "../../db/schema/index.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { type ActivationActor, activateContract } from "./activation.service.js";
import { recordCommercialEvent } from "./events.js";

/**
 * Migration 0023 — payment confirmation, the third activation condition.
 * UL Platform records THAT a trusted source confirmed the contract's amount
 * was received; it never moves money, holds payment credentials or issues
 * invoices. Two sources, one rule set:
 *  - manual: a platform administrator with `platform.payment.confirm`
 *    declares the payment was effectively received, with its reference and an
 *    internal evidence pointer (audited);
 *  - integration: an authenticated PLATFORM_SERVICE credential of the
 *    payments application with `payment.confirm` (validated by the route).
 *
 * Validation (both): the contract exists and is `pending_activation`; amount
 * and currency are EXACTLY the contract's (no partial payments in this
 * phase); the external reference was never used by that source; at most one
 * confirmed payment per contract. Idempotent: the same Idempotency-Key with
 * the same content returns the recorded payment (`replayed`), with different
 * content is a 409. After the confirmation commits, activation is attempted
 * through the ONE activation path (activateContract), which re-checks all
 * three conditions; a blocker (e.g. suspended organization) leaves the payment
 * recorded and the contract pending, and is reported back.
 */

export const confirmPaymentSchema = z
  .object({
    amountMinor: z.string().regex(/^\d{1,18}$/, "amountMinor must be an integer string of minor units"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    method: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "method must be a short lowercase code, e.g. bank_transfer"),
    externalReference: z.string().trim().min(1).max(200),
    receivedAt: z.coerce.date(),
    evidenceReference: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;

export const confirmIntegrationPaymentSchema = confirmPaymentSchema
  .omit({ method: true, evidenceReference: true })
  .extend({ contractId: z.string().uuid() })
  .strict();

type PaymentRow = typeof commercialPayments.$inferSelect;
type Confirmer = { source: "manual"; userId: string; requestId?: string } | { source: "integration"; apiKeyId: string; requestId?: string };

/** What a caller sees — never the evidence pointer of a manual confirmation to a service caller (it is internal). */
export function paymentDto(row: PaymentRow) {
  return {
    id: row.id,
    contractId: row.contractId,
    organizationId: row.organizationId,
    status: row.status,
    source: row.source,
    method: row.method,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    externalReference: row.externalReference,
    receivedAt: row.receivedAt.toISOString(),
    confirmedAt: row.confirmedAt.toISOString(),
    confirmedByUserId: row.confirmedByUserId,
    confirmedByApiKeyId: row.confirmedByApiKeyId,
  };
}

function sameConfirmation(row: PaymentRow, contractId: string, input: { amountMinor: string; currency: string; externalReference: string; method: string }, confirmer: Confirmer) {
  return (
    row.contractId === contractId &&
    row.source === confirmer.source &&
    row.amountMinor.toString() === input.amountMinor &&
    row.currency === input.currency &&
    row.externalReference === input.externalReference &&
    row.method === input.method &&
    (confirmer.source === "manual" ? row.confirmedByUserId === confirmer.userId : row.confirmedByApiKeyId === confirmer.apiKeyId)
  );
}

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

async function recordConfirmation(
  contractId: string,
  input: { amountMinor: string; currency: string; method: string; externalReference: string; receivedAt: Date; evidenceReference?: string },
  idempotencyKey: string,
  confirmer: Confirmer,
): Promise<{ payment: PaymentRow; replayed: boolean }> {
  if (input.receivedAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) throw new AppError(400, "VALIDATION_ERROR", "receivedAt cannot be in the future");
  return db.transaction(async (tx) => {
    // Replay of the same request first — answered whatever the contract's state is now.
    const [byKey] = await tx.select().from(commercialPayments).where(eq(commercialPayments.idempotencyKey, idempotencyKey)).limit(1);
    if (byKey) {
      if (sameConfirmation(byKey, contractId, input, confirmer)) return { payment: byKey, replayed: true };
      throw new ConflictError("This Idempotency-Key was already used for a different payment confirmation");
    }

    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, contractId)).for("update");
    if (!contract) throw new NotFoundError("Contract not found");

    const [existing] = await tx
      .select()
      .from(commercialPayments)
      .where(and(eq(commercialPayments.contractId, contractId), eq(commercialPayments.status, "confirmed")))
      .limit(1);
    if (existing) {
      // The same confirmation arriving again under another key (e.g. a re-delivered integration notice) is not a second payment.
      if (sameConfirmation(existing, contractId, input, confirmer)) return { payment: existing, replayed: true };
      throw new AppError(409, "PAYMENT_ALREADY_CONFIRMED", "This contract already has a confirmed payment");
    }
    const [referenceUsed] = await tx
      .select({ id: commercialPayments.id })
      .from(commercialPayments)
      .where(and(eq(commercialPayments.source, confirmer.source), eq(commercialPayments.externalReference, input.externalReference)))
      .limit(1);
    if (referenceUsed) throw new AppError(409, "PAYMENT_REFERENCE_IN_USE", "This payment reference was already used to confirm another contract");
    if (contract.status !== "pending_activation") throw new AppError(409, "CONTRACT_NOT_PAYABLE", `A ${contract.status} contract cannot receive a payment confirmation`);
    if (contract.currency !== input.currency || contract.totalMinor.toString() !== input.amountMinor) {
      throw new AppError(409, "PAYMENT_AMOUNT_MISMATCH", "The amount or currency does not match the contract");
    }

    const [payment] = await tx
      .insert(commercialPayments)
      .values({
        contractId,
        organizationId: contract.organizationId,
        source: confirmer.source,
        method: input.method,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        externalReference: input.externalReference,
        receivedAt: input.receivedAt,
        confirmedByUserId: confirmer.source === "manual" ? confirmer.userId : null,
        confirmedByApiKeyId: confirmer.source === "integration" ? confirmer.apiKeyId : null,
        evidenceReference: input.evidenceReference ?? null,
        idempotencyKey,
      })
      .returning();

    await recordCommercialEvent(tx, {
      aggregateType: "payment",
      aggregateId: payment!.id,
      eventType: "payment.confirmed",
      organizationId: contract.organizationId,
      actorType: confirmer.source === "manual" ? "platform_admin" : "system",
      actorUserId: confirmer.source === "manual" ? confirmer.userId : null,
      correlationId: confirmer.requestId,
      idempotencyKey: `payment.confirmed:${payment!.id}`,
      payload: {
        contractId,
        source: confirmer.source,
        method: input.method,
        amountMinor: input.amountMinor,
        currency: input.currency,
        ...(confirmer.source === "integration" ? { apiKeyId: confirmer.apiKeyId } : {}),
      },
    });
    // No reference or evidence content in the audit trail — the payment row is the record.
    await recordAuditEvent(
      {
        actorUserId: confirmer.source === "manual" ? confirmer.userId : undefined,
        organizationId: contract.organizationId,
        action: "platform.commercial.payment.confirmed",
        targetType: "contract",
        targetId: contractId,
        metadata: { paymentId: payment!.id, source: confirmer.source, method: input.method, amountMinor: input.amountMinor, currency: input.currency, hasEvidence: !!input.evidenceReference, ...(confirmer.source === "integration" ? { apiKeyId: confirmer.apiKeyId } : {}) },
      },
      tx,
    );
    return { payment: payment!, replayed: false };
  });
}

/** After the confirmation is committed: the one activation path re-checks all three conditions. A blocker is reported, never thrown. */
async function activateAfterPayment(contractId: string, actor: ActivationActor) {
  try {
    const { created } = await activateContract(contractId, actor);
    return { activated: true, alreadyActive: !created, blocker: null };
  } catch (error) {
    if (error instanceof AppError) return { activated: false, alreadyActive: false, blocker: { code: error.code, message: error.message } };
    throw error;
  }
}

export async function confirmManualPayment(contractId: string, input: ConfirmPaymentInput, idempotencyKey: string, admin: { userId: string; requestId?: string }) {
  const { payment, replayed } = await recordConfirmation(contractId, input, idempotencyKey, { source: "manual", userId: admin.userId, requestId: admin.requestId });
  const activation = await activateAfterPayment(contractId, { userId: admin.userId, requestId: admin.requestId });
  return { payment: { ...paymentDto(payment), evidenceReference: payment.evidenceReference }, replayed, activation };
}

export async function confirmIntegrationPayment(input: z.infer<typeof confirmIntegrationPaymentSchema>, idempotencyKey: string, service: { apiKeyId: string; applicationKey: string; requestId?: string }) {
  const { contractId, ...rest } = input;
  // The method is the confirming application itself (e.g. MICHA_EXPRESS → micha_express), never a request field.
  const { payment, replayed } = await recordConfirmation(contractId, { ...rest, method: service.applicationKey.toLowerCase() }, idempotencyKey, { source: "integration", apiKeyId: service.apiKeyId, requestId: service.requestId });
  const activation = await activateAfterPayment(contractId, { system: true, apiKeyId: service.apiKeyId, requestId: service.requestId });
  return { payment: paymentDto(payment), replayed, activation };
}

