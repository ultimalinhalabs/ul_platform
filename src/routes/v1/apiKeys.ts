import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireOrganizationMembership } from "../../middleware/organizationContext.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import { createApiKeySchema } from "../../modules/apiKeys/schemas.js";
import {
  createOrganizationApiKey,
  createPlatformApiKey,
  getApiKeyDetail,
  listApiKeysForOrganization,
  listPlatformApiKeys,
  revokeApiKey,
  revokePlatformApiKey,
} from "../../modules/apiKeys/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Human-only, organization-scoped API key management. `api_key.manage`
 * (create/revoke, OWNER-only in the seed — same posture as
 * `subscription.manage`/`organization.delete`) vs `api_key.read`
 * (metadata only, OWNER+ADMIN). There is no endpoint here for a
 * platform-level (organizationId = null) key — see
 * modules/apiKeys/service.ts and README for why that's a deliberate gap,
 * not an oversight.
 */
export const apiKeysRouter = Router();

apiKeysRouter.post(
  "/organizations/:organizationId/api-keys",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("api_key.manage"),
  asyncHandler(async (req, res) => {
    const body = createApiKeySchema.parse(req.body);
    const apiKey = await createOrganizationApiKey({
      organizationId: req.membership!.organizationId,
      applicationKey: body.applicationKey,
      expiresAt: body.expiresAt,
      scopes: body.scopes,
      actorUserId: req.auth!.userId,
    });
    // secret is present in this one response only — never again
    ok(res, apiKey, 201);
  }),
);

apiKeysRouter.get(
  "/organizations/:organizationId/api-keys",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("api_key.read"),
  asyncHandler(async (req, res) => {
    const apiKeys = await listApiKeysForOrganization(req.membership!.organizationId);
    ok(res, apiKeys);
  }),
);

apiKeysRouter.get(
  "/organizations/:organizationId/api-keys/:keyId",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("api_key.read"),
  asyncHandler(async (req, res) => {
    const apiKey = await getApiKeyDetail(req.membership!.organizationId, paramString(req.params.keyId)!);
    ok(res, apiKey);
  }),
);

apiKeysRouter.post(
  "/organizations/:organizationId/api-keys/:keyId/revoke",
  authenticate,
  requireOrganizationMembership(),
  requirePermission("api_key.manage"),
  asyncHandler(async (req, res) => {
    const apiKey = await revokeApiKey({
      organizationId: req.membership!.organizationId,
      keyId: paramString(req.params.keyId)!,
      actorUserId: req.auth!.userId,
    });
    ok(res, apiKey);
  }),
);

/**
 * Platform-level (organizationId = null) credentials — "the NA_PISTA
 * backend itself", not any one Organization's integration with it. A
 * completely separate authorization chain from the routes above: gated
 * behind `platform.credential.*`, resolved purely from
 * `platform_memberships` via `requirePlatformMembership`, never from any
 * Organization/Membership table. See modules/apiKeys/service.ts's
 * createPlatformApiKey for why this was schema-ready since Phase 12 but
 * unreachable over HTTP until now.
 */
apiKeysRouter.post(
  "/platform/credentials",
  authenticate,
  rateLimit({ keyPrefix: "platform.credential.manage", windowMs: 5 * 60_000, max: 10 }),
  requirePlatformMembership(),
  requirePlatformPermission("platform.credential.manage"),
  asyncHandler(async (req, res) => {
    const body = createApiKeySchema.parse(req.body);
    const apiKey = await createPlatformApiKey({
      applicationKey: body.applicationKey,
      expiresAt: body.expiresAt,
      scopes: body.scopes,
      actorUserId: req.auth!.userId,
    });
    // secret is present in this one response only — never again
    ok(res, apiKey, 201);
  }),
);

apiKeysRouter.get(
  "/platform/credentials",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.credential.read"),
  asyncHandler(async (_req, res) => {
    ok(res, await listPlatformApiKeys());
  }),
);

apiKeysRouter.post(
  "/platform/credentials/:keyId/revoke",
  authenticate,
  rateLimit({ keyPrefix: "platform.credential.manage", windowMs: 5 * 60_000, max: 20 }),
  requirePlatformMembership(),
  requirePlatformPermission("platform.credential.manage"),
  asyncHandler(async (req, res) => {
    const apiKey = await revokePlatformApiKey({
      keyId: paramString(req.params.keyId)!,
      actorUserId: req.auth!.userId,
    });
    ok(res, apiKey);
  }),
);
