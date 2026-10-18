import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import {
  listCommercialEventsQuerySchema,
  listContractsQuerySchema,
  listOrganizationsQuerySchema,
  listProvisioningsQuerySchema,
  organizationIdParam,
} from "../../modules/commercial/platformRead.schemas.js";
import {
  getPlatformCommercialSummary,
  getPlatformOrganization,
  listPlatformCommercialEvents,
  listPlatformContracts,
  listPlatformOrganizationMembers,
  listPlatformOrganizations,
  listPlatformProvisionings,
  listPlatformTerms,
} from "../../modules/commercial/platformRead.service.js";
import { approveTerms, approveTermsSchema, getPlatformTermsDetail, termsIdParam } from "../../modules/commercial/terms.service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ok } from "../../shared/response.js";

/**
 * UL Console MVP — platform-plane READ APIs of the commercial domain. Every route: a human
 * PLATFORM_ADMIN (`requirePlatformMembership` refuses service credentials and organization roles)
 * whose platform role carries `platform.commercial.read`. Read-only; no new permission. Organization
 * IDs come from the path/query and are only ever used as a filter — never as an authorization input.
 */
export const platformCommercialReadRouter = Router();

const read = [authenticate, requirePlatformMembership(), requirePlatformPermission("platform.commercial.read")];

platformCommercialReadRouter.get(
  "/platform/organizations",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listPlatformOrganizations(listOrganizationsQuerySchema.parse(req.query)))),
);

platformCommercialReadRouter.get(
  "/platform/organizations/:organizationId",
  ...read,
  asyncHandler(async (req, res) => ok(res, await getPlatformOrganization(organizationIdParam.parse(req.params.organizationId)))),
);

platformCommercialReadRouter.get(
  "/platform/organizations/:organizationId/members",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listPlatformOrganizationMembers(organizationIdParam.parse(req.params.organizationId)))),
);

platformCommercialReadRouter.get(
  "/platform/commercial/terms",
  ...read,
  asyncHandler(async (_req, res) => ok(res, await listPlatformTerms())),
);

// Terms approval from the UL Console (owner decision 2026-10-18, migration 0030).
platformCommercialReadRouter.get(
  "/platform/commercial/terms/:termsId",
  ...read,
  asyncHandler(async (req, res) => ok(res, await getPlatformTermsDetail(termsIdParam.parse(req.params.termsId)))),
);

platformCommercialReadRouter.post(
  "/platform/commercial/terms/:termsId/approve",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.terms.approve"),
  rateLimit({ keyPrefix: "platform.terms.approve", windowMs: 60_000, max: 10 }),
  asyncHandler(async (req, res) => {
    const result = await approveTerms(termsIdParam.parse(req.params.termsId), approveTermsSchema.parse(req.body), { userId: req.auth!.userId, requestId: req.requestId });
    res.set("Cache-Control", "no-store");
    ok(res, result);
  }),
);

platformCommercialReadRouter.get(
  "/platform/contracts",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listPlatformContracts(listContractsQuerySchema.parse(req.query)))),
);

platformCommercialReadRouter.get(
  "/platform/credential-provisionings",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listPlatformProvisionings(listProvisioningsQuerySchema.parse(req.query)))),
);

platformCommercialReadRouter.get(
  "/platform/commercial/events",
  ...read,
  asyncHandler(async (req, res) => ok(res, await listPlatformCommercialEvents(listCommercialEventsQuerySchema.parse(req.query)))),
);

platformCommercialReadRouter.get(
  "/platform/commercial/summary",
  ...read,
  asyncHandler(async (_req, res) => ok(res, await getPlatformCommercialSummary())),
);
