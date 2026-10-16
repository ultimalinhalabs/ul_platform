import express, { type NextFunction, type Request, type Response, Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { acceptProposal, getRecipientProposal, listMyProposals } from "../../modules/commercial/acceptance.service.js";
import { getOrganizationContract, listOrganizationContracts } from "../../modules/commercial/contracts.service.js";
import { MAX_PROOF_BYTES, getPaymentInstructions, uploadPaymentProof, uploadProofQuerySchema } from "../../modules/commercial/paymentProofs.service.js";
import { authorizeRenewal, authorizeRenewalSchema, withdrawRenewalAuthorization } from "../../modules/commercial/renewals.service.js";
import { acceptProposalSchema, idempotencyKeySchema } from "../../modules/commercial/schemas.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ForbiddenError, ValidationError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Block 1C — the CLIENT side of the commercial domain, separate from the
 * platform routes of Block 1B (which are never exposed to clients).
 *  - Proposals: only the VERIFIED recipient (email) sees and accepts them;
 *    the public link token is never part of this flow.
 *  - Contracts: an active OWNER of the organization reads that
 *    organization's contracts. Expressed with the existing membership context
 *    (roleKey) — no platform permission is granted to clients and no new
 *    permission/migration is needed for the MVP.
 * Human sessions only: service credentials are refused.
 */
export const clientCommercialRouter = Router();

function requireHumanSession(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new ForbiddenError("A user session is required"));
  next();
}

function requireOrganizationOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.membership?.roleKey !== "OWNER") return next(new ForbiddenError("Only an OWNER of the organization can view its contracts"));
  next();
}

clientCommercialRouter.get(
  "/me/proposals",
  authenticate,
  requireHumanSession,
  asyncHandler(async (req, res) => ok(res, await listMyProposals(req.auth!.userId))),
);

clientCommercialRouter.get(
  "/proposals/:proposalId",
  authenticate,
  requireHumanSession,
  asyncHandler(async (req, res) => ok(res, await getRecipientProposal(paramString(req.params.proposalId)!, req.auth!.userId))),
);

clientCommercialRouter.post(
  "/proposals/:proposalId/acceptance",
  authenticate,
  requireHumanSession,
  asyncHandler(async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");
    const result = await acceptProposal(paramString(req.params.proposalId)!, acceptProposalSchema.parse(req.body), key.data, {
      userId: req.auth!.userId,
      userAgent: req.get("user-agent") ?? null,
      requestId: req.requestId,
    });
    const { created, ...body } = result;
    ok(res, body, created ? 201 : 200);
  }),
);

clientCommercialRouter.get(
  "/organizations/:organizationId/contracts",
  authenticate,
  requireOrganizationMembership(),
  requireOrganizationOwner,
  asyncHandler(async (req, res) => ok(res, await listOrganizationContracts(req.membership!.organizationId))),
);

clientCommercialRouter.get(
  "/organizations/:organizationId/contracts/:contractId",
  authenticate,
  requireOrganizationMembership(),
  requireOrganizationOwner,
  asyncHandler(async (req, res) => ok(res, await getOrganizationContract(req.membership!.organizationId, paramString(req.params.contractId)!))),
);

// ---------------------------------------------------------------------------- Migrations 0026/0027 — paying and renewing
// Same authority as reading contracts: an active OWNER of THIS organization (the contract is always looked up
// scoped by the organization from the membership, never from the body).
const ownerOfOrg = [authenticate, requireOrganizationMembership(), requireOrganizationOwner];
const contractId = (req: Request) => paramString(req.params.contractId)!;

clientCommercialRouter.get(
  "/organizations/:organizationId/contracts/:contractId/payment-instructions",
  ...ownerOfOrg,
  asyncHandler(async (req, res) => {
    const renewalId = typeof req.query.renewalId === "string" && req.query.renewalId ? req.query.renewalId : undefined;
    if (renewalId && !/^[0-9a-f-]{36}$/i.test(renewalId)) throw new ValidationError("renewalId must be a UUID");
    ok(res, await getPaymentInstructions(req.membership!.organizationId, contractId(req), renewalId));
  }),
);

/** The PDF is the raw request body (Content-Type: application/pdf, at most 4 MB); what it proves goes in the query. */
clientCommercialRouter.post(
  "/organizations/:organizationId/contracts/:contractId/payment-proofs",
  ...ownerOfOrg,
  rateLimit({ keyPrefix: "client.payment_proof.upload", windowMs: 10 * 60_000, max: 20 }),
  express.raw({ type: "application/pdf", limit: MAX_PROOF_BYTES }),
  asyncHandler(async (req, res) => {
    const query = uploadProofQuerySchema.parse(req.query);
    const result = await uploadPaymentProof({
      organizationId: req.membership!.organizationId,
      contractId: contractId(req),
      renewalId: query.renewalId,
      method: query.method,
      reference: query.reference,
      fileName: query.fileName,
      content: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      userId: req.auth!.userId,
      requestId: req.requestId,
    });
    ok(res, result, result.replayed ? 200 : 201);
  }),
);

clientCommercialRouter.post(
  "/organizations/:organizationId/contracts/:contractId/renewal-authorization",
  ...ownerOfOrg,
  asyncHandler(async (req, res) => {
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");
    const result = await authorizeRenewal(req.membership!.organizationId, contractId(req), authorizeRenewalSchema.parse(req.body), key.data, { userId: req.auth!.userId, requestId: req.requestId });
    ok(res, result.authorization, result.created ? 201 : 200);
  }),
);

clientCommercialRouter.post(
  "/organizations/:organizationId/contracts/:contractId/renewal-authorization/withdrawal",
  ...ownerOfOrg,
  asyncHandler(async (req, res) => ok(res, await withdrawRenewalAuthorization(req.membership!.organizationId, contractId(req), { userId: req.auth!.userId, requestId: req.requestId }))),
);
