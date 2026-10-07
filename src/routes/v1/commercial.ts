import { type Request, Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { z } from "zod";
import { createAccessLink, listAccessLinks, revokeAccessLink } from "../../modules/commercial/accessLinks.service.js";
import {
  activateContract,
  cancelContract,
  getPlatformContract,
  previewActivation,
  revokeGrant,
  terminateContract,
} from "../../modules/commercial/activation.service.js";
import type { CommercialActor } from "../../modules/commercial/events.js";
import {
  createItem,
  createOption,
  createProposal,
  createVersion,
  deleteItem,
  deleteOption,
  getProposalDetail,
  getVersionDetail,
  listProposals,
  sendVersion,
  updateItem,
  updateOption,
  updateProposal,
  updateVersion,
} from "../../modules/commercial/proposals.service.js";
import {
  createAccessLinkSchema,
  createItemSchema,
  createOptionSchema,
  createProposalSchema,
  listProposalsQuerySchema,
  updateItemSchema,
  updateOptionSchema,
  updateProposalSchema,
  updateVersionSchema,
} from "../../modules/commercial/schemas.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Block 1B — commercial administration (UL team / Console). Platform plane
 * only: a human PLATFORM_ADMIN whose role carries the permission
 * (`requirePlatformMembership` refuses service credentials). Organization
 * OWNER/ADMIN roles grant nothing here. Reads: platform.commercial.read;
 * drafting: platform.proposal.manage; sending and public links:
 * platform.proposal.send. No permission is granted to users directly.
 */
export const commercialRouter = Router();

const read = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.commercial.read")];
const manage = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.proposal.manage")];
const send = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.proposal.send")];

const actor = (req: Request): CommercialActor => ({ userId: req.auth!.userId, requestId: req.requestId });
const p = (req: Request, name: string) => paramString(req.params[name])!;

commercialRouter.get(
  "/platform/proposals",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listProposals(listProposalsQuerySchema.parse(req.query)))),
);

commercialRouter.post(
  "/platform/proposals",
  ...manage,
  asyncHandler(async (req, res) => ok(res, await createProposal(createProposalSchema.parse(req.body), actor(req)), 201)),
);

commercialRouter.get(
  "/platform/proposals/:proposalId",
  ...read,
  asyncHandler(async (req, res) => ok(res, await getProposalDetail(p(req, "proposalId")))),
);

commercialRouter.patch(
  "/platform/proposals/:proposalId",
  ...manage,
  asyncHandler(async (req, res) => ok(res, await updateProposal(p(req, "proposalId"), updateProposalSchema.parse(req.body), actor(req)))),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/versions",
  ...manage,
  asyncHandler(async (req, res) => ok(res, await createVersion(p(req, "proposalId"), actor(req)), 201)),
);

commercialRouter.get(
  "/platform/proposals/:proposalId/versions/:versionId",
  ...read,
  asyncHandler(async (req, res) => ok(res, await getVersionDetail(p(req, "proposalId"), p(req, "versionId")))),
);

commercialRouter.patch(
  "/platform/proposals/:proposalId/versions/:versionId",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(res, await updateVersion(p(req, "proposalId"), p(req, "versionId"), updateVersionSchema.parse(req.body), actor(req))),
  ),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/versions/:versionId/send",
  ...send,
  asyncHandler(async (req, res) => ok(res, await sendVersion(p(req, "proposalId"), p(req, "versionId"), actor(req)))),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/versions/:versionId/options",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(res, await createOption(p(req, "proposalId"), p(req, "versionId"), createOptionSchema.parse(req.body), actor(req)), 201),
  ),
);

commercialRouter.patch(
  "/platform/proposals/:proposalId/versions/:versionId/options/:optionId",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(res, await updateOption(p(req, "proposalId"), p(req, "versionId"), p(req, "optionId"), updateOptionSchema.parse(req.body), actor(req))),
  ),
);

commercialRouter.delete(
  "/platform/proposals/:proposalId/versions/:versionId/options/:optionId",
  ...manage,
  asyncHandler(async (req, res) => ok(res, await deleteOption(p(req, "proposalId"), p(req, "versionId"), p(req, "optionId"), actor(req)))),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/versions/:versionId/options/:optionId/items",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(res, await createItem(p(req, "proposalId"), p(req, "versionId"), p(req, "optionId"), createItemSchema.parse(req.body), actor(req)), 201),
  ),
);

commercialRouter.patch(
  "/platform/proposals/:proposalId/versions/:versionId/options/:optionId/items/:itemId",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(
      res,
      await updateItem(p(req, "proposalId"), p(req, "versionId"), p(req, "optionId"), p(req, "itemId"), updateItemSchema.parse(req.body), actor(req)),
    ),
  ),
);

commercialRouter.delete(
  "/platform/proposals/:proposalId/versions/:versionId/options/:optionId/items/:itemId",
  ...manage,
  asyncHandler(async (req, res) =>
    ok(res, await deleteItem(p(req, "proposalId"), p(req, "versionId"), p(req, "optionId"), p(req, "itemId"), actor(req))),
  ),
);

commercialRouter.get(
  "/platform/proposals/:proposalId/links",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listAccessLinks(p(req, "proposalId")))),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/links",
  ...send,
  asyncHandler(async (req, res) => {
    // The token is returned once; never cache this response.
    res.set("Cache-Control", "no-store");
    ok(res, await createAccessLink(p(req, "proposalId"), createAccessLinkSchema.parse(req.body ?? {}), actor(req)), 201);
  }),
);

commercialRouter.post(
  "/platform/proposals/:proposalId/links/:linkId/revoke",
  ...send,
  asyncHandler(async (req, res) => ok(res, await revokeAccessLink(p(req, "proposalId"), p(req, "linkId"), actor(req)))),
);

// ---------------------------------------------------------------------------- Block 1D — contracts & entitlements
// Activation and revocation: platform.entitlement.grant. Cancellation/termination: platform.contract.manage.
// The tenant is always the contract's organization; no organizationId is read from the request.
const grant = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.entitlement.grant")];
const contractManage = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.contract.manage")];
const revocationSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

commercialRouter.get(
  "/platform/contracts/:contractId",
  ...read,
  asyncHandler(async (req, res) => ok(res, await getPlatformContract(p(req, "contractId")))),
);

commercialRouter.get(
  "/platform/contracts/:contractId/activation-preview",
  ...read,
  asyncHandler(async (req, res) => ok(res, await previewActivation(p(req, "contractId")))),
);

commercialRouter.post(
  "/platform/contracts/:contractId/activation",
  ...grant,
  asyncHandler(async (req, res) => {
    const { created, contract } = await activateContract(p(req, "contractId"), actor(req));
    ok(res, contract, created ? 201 : 200);
  }),
);

commercialRouter.post(
  "/platform/contracts/:contractId/cancellation",
  ...contractManage,
  asyncHandler(async (req, res) => ok(res, await cancelContract(p(req, "contractId"), actor(req)))),
);

commercialRouter.post(
  "/platform/contracts/:contractId/termination",
  ...contractManage,
  asyncHandler(async (req, res) => ok(res, await terminateContract(p(req, "contractId"), actor(req)))),
);

commercialRouter.post(
  "/platform/entitlement-grants/:grantId/revocation",
  ...grant,
  asyncHandler(async (req, res) => ok(res, await revokeGrant(p(req, "grantId"), revocationSchema.parse(req.body ?? {}).reason, actor(req)))),
);
