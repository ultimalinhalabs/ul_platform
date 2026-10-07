import { Router } from "express";
import { z } from "zod";
import { authenticate, authenticateAllowingPending } from "../../middleware/authenticate.js";
import { requirePlatformMembership } from "../../middleware/platformContext.js";
import { requirePlatformPermission } from "../../middleware/requirePlatformPermission.js";
import {
  assertProvisioner,
  confirmIntegrationCredential,
  issueIntegrationCredential,
  listOpenProvisioningRequests,
  requestRekey,
  revokeProvisioningRequest,
} from "../../modules/integrationProvisioning/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ForbiddenError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

/**
 * D2-B — managed integration credential provisioning (docs/architecture/D2-B-ARCHITECTURE-REVISION.md).
 *
 * Service plane (server-to-server only; a human JWT is refused):
 *  - the PROVISIONER credential lists and issues — for its OWN application only, and only for a
 *    persisted open request; the body carries nothing but `expectedIssueCount`;
 *  - the issued (PENDING) credential confirms its own request — proof of possession.
 * Platform plane (PLATFORM_ADMIN, `platform.credential.manage`): revoke a request, or open an explicit
 * `rekey` for an ACTIVE one. There is no route that returns a secret to a person.
 */
export const credentialProvisioningRouter = Router();

const requestIdParam = z.string().uuid();
const issueBody = z.object({ expectedIssueCount: z.number().int().min(0) }).strict();
const revokeBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict();

credentialProvisioningRouter.get(
  "/service/credential-provisionings",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.service) throw new ForbiddenError("This endpoint requires a service credential");
    assertProvisioner(req.service);
    ok(res, await listOpenProvisioningRequests(req.service));
  }),
);

credentialProvisioningRouter.post(
  "/service/credential-provisionings/:id/issue",
  authenticate,
  asyncHandler(async (req, res) => {
    if (!req.service) throw new ForbiddenError("This endpoint requires a service credential");
    assertProvisioner(req.service);
    const id = requestIdParam.parse(req.params.id);
    const { expectedIssueCount } = issueBody.parse(req.body ?? {});
    // The secret travels in this response body only (HTTPS, server-to-server) — never logged.
    ok(res, await issueIntegrationCredential(req.service, id, expectedIssueCount), 201);
  }),
);

credentialProvisioningRouter.post(
  "/service/credential-provisionings/:id/confirm",
  authenticateAllowingPending,
  asyncHandler(async (req, res) => {
    if (!req.service) throw new ForbiddenError("This endpoint requires a service credential");
    const id = requestIdParam.parse(req.params.id);
    ok(res, await confirmIntegrationCredential(req.service, id));
  }),
);

credentialProvisioningRouter.post(
  "/platform/credential-provisionings/:id/revoke",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.credential.manage"),
  asyncHandler(async (req, res) => {
    const id = requestIdParam.parse(req.params.id);
    const { reason } = revokeBody.parse(req.body ?? {});
    ok(res, await revokeProvisioningRequest(id, reason, req.auth!.userId));
  }),
);

credentialProvisioningRouter.post(
  "/platform/credential-provisionings/:id/rekey",
  authenticate,
  requirePlatformMembership(),
  requirePlatformPermission("platform.credential.manage"),
  asyncHandler(async (req, res) => {
    const id = requestIdParam.parse(req.params.id);
    ok(res, await requestRekey(id, req.auth!.userId), 201);
  }),
);
