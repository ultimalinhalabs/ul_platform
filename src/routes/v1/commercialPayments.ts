import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { requireServiceScope } from "../../middleware/requireServiceScope.js";
import { idempotencyKeySchema } from "../../modules/commercial/schemas.js";
import {
  confirmIntegrationPayment,
  confirmIntegrationPaymentSchema,
  confirmManualPayment,
  confirmPaymentSchema,
} from "../../modules/commercial/payments.service.js";
import { getProofFile, listProofsForReview, rejectProof, rejectProofSchema } from "../../modules/commercial/paymentProofs.service.js";
import { applyRenewal, listAwaitingRenewals } from "../../modules/commercial/renewals.service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ForbiddenError, ValidationError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Migration 0023 — payment confirmation (modules/commercial/payments.service.ts).
 *
 *  - Manual: a human platform administrator whose role carries
 *    `platform.payment.confirm` declares that the contract's amount was
 *    effectively received (reference, method, date, evidence pointer). Service
 *    credentials never reach this route (requirePlatformMembership).
 *  - Integration: UL Platform's OWN inbound contract for the payments
 *    application — a PLATFORM_SERVICE credential holding `payment.confirm`
 *    (allow-listed for MICHA_EXPRESS only). The Micha Express side of this
 *    integration is not specified yet (no Micha Express API exists in the
 *    workspace): this endpoint defines what UL accepts, nothing about how
 *    Micha Express works internally.
 *
 * Both require an Idempotency-Key, and both end in the one activation path.
 * 201 on a new confirmation, 200 on a replay.
 */
export const commercialPaymentsRouter = Router();

function requireKey(header: string | undefined) {
  const key = idempotencyKeySchema.safeParse(header);
  if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");
  return key.data;
}

commercialPaymentsRouter.post(
  "/platform/contracts/:contractId/payments",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.payment.confirm"),
  rateLimit({ keyPrefix: "platform.payment.confirm", windowMs: 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    const key = requireKey(req.get("idempotency-key"));
    const result = await confirmManualPayment(paramString(req.params.contractId)!, confirmPaymentSchema.parse(req.body), key, { userId: req.auth!.userId, requestId: req.requestId });
    res.set("Cache-Control", "no-store");
    ok(res, result, result.replayed ? 200 : 201);
  }),
);

commercialPaymentsRouter.post(
  "/service/payments/confirmations",
  authenticate,
  requireServiceScope("payment.confirm"),
  rateLimit({ keyPrefix: "service.payment.confirm", windowMs: 60_000, max: 120 }),
  asyncHandler(async (req, res) => {
    if (req.service!.credentialClass !== "PLATFORM_SERVICE") {
      throw new ForbiddenError("Payments can only be confirmed with a platform service credential");
    }
    const key = requireKey(req.get("idempotency-key"));
    const result = await confirmIntegrationPayment(confirmIntegrationPaymentSchema.parse(req.body), key, {
      apiKeyId: req.service!.apiKeyId,
      applicationKey: req.service!.applicationKey,
      requestId: req.requestId,
    });
    res.set("Cache-Control", "no-store");
    ok(res, result, result.replayed ? 200 : 201);
  }),
);

// ---------------------------------------------------------------------------- Migrations 0026/0027 — operations
// Proofs: reading a client's PDF is its own permission (platform.payment_proof.read, also held by the prepared
// PLATFORM_FINANCE role); rejecting one is part of confirming payments (platform.payment.confirm).
const proofRead = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.payment_proof.read")];

commercialPaymentsRouter.get(
  "/platform/payment-proofs",
  ...proofRead,
  asyncHandler(async (_req, res) => ok(res, await listProofsForReview("submitted"))),
);

commercialPaymentsRouter.get(
  "/platform/payment-proofs/:proofId/file",
  ...proofRead,
  asyncHandler(async (req, res) => {
    const file = await getProofFile(paramString(req.params.proofId)!, { userId: req.auth!.userId });
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "application/pdf");
    res.set("X-Content-Type-Options", "nosniff");
    // Downloaded, never rendered inline in this origin.
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.send(file.content);
  }),
);

commercialPaymentsRouter.post(
  "/platform/payment-proofs/:proofId/rejection",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.payment.confirm"),
  asyncHandler(async (req, res) => ok(res, await rejectProof(paramString(req.params.proofId)!, rejectProofSchema.parse(req.body ?? {}).reason, { userId: req.auth!.userId, requestId: req.requestId }))),
);

commercialPaymentsRouter.get(
  "/platform/renewals",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.commercial.read"),
  asyncHandler(async (_req, res) => ok(res, await listAwaitingRenewals())),
);

/** A paid renewal that could not be applied right after its payment (e.g. organization suspended), applied explicitly. */
commercialPaymentsRouter.post(
  "/platform/renewals/:renewalId/activation",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.entitlement.grant"),
  asyncHandler(async (req, res) => {
    const result = await applyRenewal(paramString(req.params.renewalId)!, { userId: req.auth!.userId, requestId: req.requestId });
    ok(res, result, result.applied ? 201 : 200);
  }),
);
