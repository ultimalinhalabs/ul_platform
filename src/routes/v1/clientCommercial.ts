import { type NextFunction, type Request, type Response, Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { acceptProposal, getRecipientProposal, listMyProposals } from "../../modules/commercial/acceptance.service.js";
import { getOrganizationContract, listOrganizationContracts } from "../../modules/commercial/contracts.service.js";
import { acceptProposalSchema, idempotencyKeySchema } from "../../modules/commercial/schemas.js";
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
