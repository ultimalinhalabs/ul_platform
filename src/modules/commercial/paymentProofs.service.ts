import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { commercialPayments, contractRenewals, contracts, organizations, paymentProofFiles, paymentProofs, PAYMENT_PROOF_METHODS } from "../../db/schema/index.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { enqueueEmail } from "../email/outbox.js";
import { proofRejectedEmail, proofSubmittedEmail } from "../email/templates.js";
import { recordCommercialEvent } from "./events.js";
import { clientContractUrl, consoleContractUrl, ownerEmails, paymentMethodsConfigured, renewalReference } from "./notify.js";

/**
 * Migration 0027 — payment instructions and the client's PDF proof (owner
 * decision 2026-10-16: pay by IBAN transfer or Multicaixa Express, then upload
 * the proof). A proof never confirms anything: a UL administrator checks that
 * the money was received and confirms the payment (commercial_payments),
 * optionally naming the proof it accepted; or rejects the proof with a reason.
 *
 * What can be paid ("the target"): the first period of a contract pending
 * activation without a confirmed payment, or a renewal awaiting payment of an
 * active contract. Everything is scoped by the organization from the route.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type ProofRow = typeof paymentProofs.$inferSelect;

export const MAX_PROOF_BYTES = 4 * 1024 * 1024;
/** At most this many proofs waiting for review per target (abuse bound; a rejected one frees its place). */
export const MAX_SUBMITTED_PROOFS = 5;

export const uploadProofQuerySchema = z
  .object({
    method: z.enum(PAYMENT_PROOF_METHODS),
    reference: z.string().trim().min(1).max(200),
    fileName: z.string().trim().min(1).max(200).optional(),
    renewalId: z.string().uuid().optional(),
  })
  .strict();

export const rejectProofSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export function proofDto(row: ProofRow) {
  return {
    id: row.id,
    contractId: row.contractId,
    renewalId: row.renewalId,
    method: row.method,
    declaredReference: row.declaredReference,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    status: row.status,
    rejectionReason: row.rejectionReason,
    uploadedByUserId: row.uploadedByUserId,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listProofs(executor: Executor, contractId: string) {
  const rows = await executor.select().from(paymentProofs).where(eq(paymentProofs.contractId, contractId)).orderBy(desc(paymentProofs.createdAt));
  return rows.map(proofDto);
}

interface PayTarget {
  kind: "contract" | "renewal";
  contract: typeof contracts.$inferSelect;
  renewal: typeof contractRenewals.$inferSelect | null;
  reference: string;
  amountMinor: bigint;
  currency: string;
  /** For a renewal: pay before this moment (the current period's end) or access ends. */
  dueAt: Date | null;
}

/** Resolves what the organization can pay now; 404 for another organization's contract, 409 when nothing is payable. */
async function resolveTarget(executor: Executor, organizationId: string, contractId: string, renewalId: string | undefined, lock = false): Promise<PayTarget> {
  const q = executor.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.organizationId, organizationId)));
  const [contract] = lock ? await q.for("update") : await q;
  if (!contract) throw new NotFoundError("Contract not found");
  if (renewalId) {
    const [renewal] = await executor.select().from(contractRenewals).where(and(eq(contractRenewals.id, renewalId), eq(contractRenewals.contractId, contract.id)));
    if (!renewal) throw new NotFoundError("Renewal not found");
    if (renewal.status !== "awaiting_payment" || contract.status !== "active") throw new AppError(409, "NOTHING_TO_PAY", "This renewal is not awaiting payment");
    return { kind: "renewal", contract, renewal, reference: renewalReference(contract.number, renewal.sequence), amountMinor: renewal.amountMinor, currency: renewal.currency, dueAt: renewal.periodStartsAt };
  }
  const [paid] = await executor
    .select({ id: commercialPayments.id })
    .from(commercialPayments)
    .where(and(eq(commercialPayments.contractId, contract.id), eq(commercialPayments.status, "confirmed"), isNull(commercialPayments.renewalId)))
    .limit(1);
  if (contract.status !== "pending_activation" || paid) throw new AppError(409, "NOTHING_TO_PAY", "This contract has nothing to pay");
  return { kind: "contract", contract, renewal: null, reference: contract.number, amountMinor: contract.totalMinor, currency: contract.currency, dueAt: null };
}

/** What to pay, to whom and how — read by the client before paying. */
export async function getPaymentInstructions(organizationId: string, contractId: string, renewalId?: string) {
  const target = await resolveTarget(db, organizationId, contractId, renewalId);
  const methods = paymentMethodsConfigured();
  return {
    target: { kind: target.kind, contractId: target.contract.id, renewalId: target.renewal?.id ?? null, reference: target.reference, amountMinor: target.amountMinor.toString(), currency: target.currency, dueAt: target.dueAt?.toISOString() ?? null },
    methods: {
      bankTransfer: methods.bankTransfer ? { bankName: methods.bankTransfer.bankName ?? null, accountHolder: methods.bankTransfer.accountHolder ?? null, iban: methods.bankTransfer.iban } : null,
      multicaixaExpress: methods.multicaixaExpress ? { number: methods.multicaixaExpress.number } : null,
    },
    proof: { required: true, contentType: "application/pdf", maxBytes: MAX_PROOF_BYTES },
  };
}

function safeFileName(name: string | undefined, reference: string): string {
  const cleaned = (name ?? "").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  const base = cleaned.length ? cleaned : `comprovativo-${reference}`;
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export async function uploadPaymentProof(input: {
  organizationId: string;
  contractId: string;
  renewalId?: string;
  method: (typeof PAYMENT_PROOF_METHODS)[number];
  reference: string;
  fileName?: string;
  content: Buffer;
  userId: string;
  requestId?: string;
}) {
  if (!Buffer.isBuffer(input.content) || input.content.length === 0) throw new ValidationError("The PDF file is required (Content-Type: application/pdf)");
  if (input.content.length > MAX_PROOF_BYTES) throw new AppError(413, "PROOF_TOO_LARGE", "The PDF must be at most 4 MB");
  // A PDF starts with "%PDF-"; anything else (an image renamed .pdf, HTML, an executable) is refused.
  if (input.content.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AppError(415, "PROOF_NOT_PDF", "The file is not a PDF");
  const sha256 = createHash("sha256").update(input.content).digest("hex");

  const result = await db.transaction(async (tx) => {
    const target = await resolveTarget(tx, input.organizationId, input.contractId, input.renewalId, true);
    const sameTarget = and(eq(paymentProofs.contractId, target.contract.id), target.renewal ? eq(paymentProofs.renewalId, target.renewal.id) : isNull(paymentProofs.renewalId));
    const [same] = await tx.select().from(paymentProofs).where(and(sameTarget, eq(paymentProofs.sha256, sha256))).limit(1);
    if (same) return { proof: same, replayed: true, target };
    const [waiting] = await tx.select({ n: count() }).from(paymentProofs).where(and(sameTarget, eq(paymentProofs.status, "submitted")));
    if (waiting!.n >= MAX_SUBMITTED_PROOFS) throw new AppError(409, "TOO_MANY_PROOFS", "Too many proofs are waiting for review for this payment");
    const [proof] = await tx
      .insert(paymentProofs)
      .values({
        organizationId: input.organizationId,
        contractId: target.contract.id,
        renewalId: target.renewal?.id ?? null,
        method: input.method,
        declaredReference: input.reference,
        fileName: safeFileName(input.fileName, target.reference),
        contentType: "application/pdf",
        sizeBytes: input.content.length,
        sha256,
        uploadedByUserId: input.userId,
      })
      .returning();
    await tx.insert(paymentProofFiles).values({ proofId: proof!.id, content: input.content });
    await recordCommercialEvent(tx, {
      aggregateType: "payment_proof",
      aggregateId: proof!.id,
      eventType: "payment_proof.submitted",
      organizationId: input.organizationId,
      actorType: "user",
      actorUserId: input.userId,
      correlationId: input.requestId,
      idempotencyKey: `payment_proof.submitted:${proof!.id}`,
      payload: { contractId: target.contract.id, renewalId: target.renewal?.id ?? null, method: input.method, sizeBytes: input.content.length, sha256 },
    });
    await recordAuditEvent({ actorUserId: input.userId, organizationId: input.organizationId, action: "commercial.payment_proof.submitted", targetType: "payment_proof", targetId: proof!.id, metadata: { contractId: target.contract.id, renewalId: target.renewal?.id ?? null, method: input.method } }, tx);
    if (env.PAYMENTS_NOTIFY_EMAIL) {
      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, input.organizationId));
      await enqueueEmail(tx, {
        kind: "commercial.payment_proof.submitted",
        to: env.PAYMENTS_NOTIFY_EMAIL,
        dedupeKey: `commercial.payment_proof.submitted:${proof!.id}`,
        ...proofSubmittedEmail({ organizationName: org!.name, contractNumber: target.contract.number, renewalSequence: target.renewal?.sequence ?? null, method: input.method, consoleUrl: consoleContractUrl(target.contract.id) }),
      });
    }
    return { proof: proof!, replayed: false, target };
  });
  return { proof: proofDto(result.proof), replayed: result.replayed };
}

/** Platform: proofs waiting for review (an operations queue), newest first. */
export async function listProofsForReview(status: (typeof paymentProofs.$inferSelect)["status"] = "submitted") {
  const rows = await db
    .select({ proof: paymentProofs, contractNumber: contracts.number, organizationName: organizations.name })
    .from(paymentProofs)
    .innerJoin(contracts, eq(contracts.id, paymentProofs.contractId))
    .innerJoin(organizations, eq(organizations.id, paymentProofs.organizationId))
    .where(eq(paymentProofs.status, status))
    .orderBy(asc(paymentProofs.createdAt))
    .limit(200);
  return rows.map((r) => ({ ...proofDto(r.proof), organizationId: r.proof.organizationId, contractNumber: r.contractNumber, organizationName: r.organizationName }));
}

/** Platform: the PDF bytes (audited — opening a client's document is a sensitive read). */
export async function getProofFile(proofId: string, actor: { userId: string }) {
  const [row] = await db
    .select({ proof: paymentProofs, content: paymentProofFiles.content })
    .from(paymentProofs)
    .innerJoin(paymentProofFiles, eq(paymentProofFiles.proofId, paymentProofs.id))
    .where(eq(paymentProofs.id, proofId));
  if (!row) throw new NotFoundError("Payment proof not found");
  await recordAuditEvent({ actorUserId: actor.userId, organizationId: row.proof.organizationId, action: "platform.commercial.payment_proof.read", targetType: "payment_proof", targetId: proofId, metadata: { contractId: row.proof.contractId } });
  return { fileName: row.proof.fileName, contentType: row.proof.contentType, content: row.content };
}

export async function rejectProof(proofId: string, reason: string, actor: { userId: string; requestId?: string }) {
  const row = await db.transaction(async (tx) => {
    const [proof] = await tx.select().from(paymentProofs).where(eq(paymentProofs.id, proofId)).for("update");
    if (!proof) throw new NotFoundError("Payment proof not found");
    if (proof.status === "rejected") return proof;
    if (proof.status !== "submitted") throw new ConflictError(`An ${proof.status} proof cannot be rejected`);
    const [updated] = await tx
      .update(paymentProofs)
      .set({ status: "rejected", rejectionReason: reason, reviewedByUserId: actor.userId, reviewedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(paymentProofs.id, proofId))
      .returning();
    await recordCommercialEvent(tx, {
      aggregateType: "payment_proof",
      aggregateId: proofId,
      eventType: "payment_proof.rejected",
      organizationId: proof.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      idempotencyKey: `payment_proof.rejected:${proofId}`,
      payload: { contractId: proof.contractId, renewalId: proof.renewalId },
    });
    await recordAuditEvent({ actorUserId: actor.userId, organizationId: proof.organizationId, action: "platform.commercial.payment_proof.rejected", targetType: "payment_proof", targetId: proofId, metadata: { contractId: proof.contractId } }, tx);
    const [contract] = await tx.select({ number: contracts.number }).from(contracts).where(eq(contracts.id, proof.contractId));
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, proof.organizationId));
    for (const to of await ownerEmails(tx, proof.organizationId)) {
      await enqueueEmail(tx, {
        kind: "commercial.payment_proof.rejected",
        to,
        dedupeKey: `commercial.payment_proof.rejected:${proofId}:${to}`,
        ...proofRejectedEmail({ organizationName: org!.name, contractNumber: contract!.number, reason, contractUrl: clientContractUrl(proof.organizationId, proof.contractId) }),
      });
    }
    return updated!;
  });
  return proofDto(row);
}

/** Inside the payment confirmation's transaction: the proof the administrator relied on becomes `accepted`. */
export async function acceptProofInTx(tx: Tx, proofId: string, target: { contractId: string; renewalId: string | null }, adminUserId: string) {
  const [proof] = await tx.select().from(paymentProofs).where(eq(paymentProofs.id, proofId)).for("update");
  if (!proof || proof.contractId !== target.contractId || (proof.renewalId ?? null) !== target.renewalId) throw new AppError(409, "PROOF_MISMATCH", "This proof does not belong to the payment being confirmed");
  if (proof.status !== "submitted") throw new AppError(409, "PROOF_NOT_SUBMITTED", `An ${proof.status} proof cannot be accepted`);
  await tx.update(paymentProofs).set({ status: "accepted", reviewedByUserId: adminUserId, reviewedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(paymentProofs.id, proofId));
}
