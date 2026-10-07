import type { NextFunction, Request, Response } from "express";
import { verifySupabaseAccessToken } from "../integrations/supabase/jwt.js";
import { isApiKeyToken } from "../modules/apiKeys/crypto.js";
import { verifyApiKeyToken } from "../modules/apiKeys/service.js";
import { assertServiceCredentialAuthorizedNow } from "../modules/integrationProvisioning/authorization.js";
import { assertOrganizationActive, getOrganizationStatus } from "../modules/organizations/service.js";
import { ensureUserExists, getUserStatus } from "../modules/users/service.js";
import { AccountDisabledError, UnauthorizedError } from "../shared/errors.js";

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  return header.slice("Bearer ".length).trim();
}

/**
 * Verifies the caller's credential and attaches exactly one of
 * `req.auth` (human, Supabase JWT) or `req.service` (machine, API key) —
 * never both, never neither on success. The `ulk_` prefix (see
 * modules/apiKeys/crypto.ts) makes this an unambiguous branch, not
 * shape-sniffing: a JWT is never treated as an API key or vice versa.
 * This is the only place a request establishes "who/what is calling" —
 * route-specific authorization/tenant checks happen in later middleware.
 *
 * D2-B — for an organization-scoped credential this is also where its
 * commercial RUNTIME authorization is enforced, on every request
 * (modules/integrationProvisioning/authorization.ts). A PENDING managed
 * credential is refused here; only the two routes that exist for it
 * (introspection and confirmation) use `authenticateAllowingPending`.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  return authenticateRequest(req, next, false);
}

/** D2-B — ONLY for `GET /service/me` and `POST /service/credential-provisionings/:id/confirm`. */
export async function authenticateAllowingPending(req: Request, _res: Response, next: NextFunction) {
  return authenticateRequest(req, next, true);
}

async function authenticateRequest(req: Request, next: NextFunction, allowPending: boolean) {
  try {
    const token = extractBearerToken(req.header("authorization"));

    if (isApiKeyToken(token)) {
      const service = await verifyApiKeyToken(token);
      // Fase 6 — an organization-scoped credential stops working while its organization is suspended.
      if (service.organizationId) {
        assertOrganizationActive(await getOrganizationStatus(service.organizationId));
      }
      if (service.status === "PENDING") {
        // Issued but not yet confirmed: no application operation, ever. Its confirmation re-checks the commercial authorization.
        if (!allowPending) throw new UnauthorizedError("Invalid API key");
      } else {
        await assertServiceCredentialAuthorizedNow(service);
      }
      req.service = service;
      return next();
    }

    const claims = await verifySupabaseAccessToken(token).catch(() => {
      throw new UnauthorizedError("Invalid or expired access token");
    });

    await ensureUserExists({ id: claims.sub, email: claims.email });

    // Fase 6 — the platform, not the IdP, decides whether this identity may operate.
    if ((await getUserStatus(claims.sub)) === "disabled") {
      throw new AccountDisabledError();
    }

    req.auth = { userId: claims.sub, email: claims.email };
    next();
  } catch (error) {
    next(error);
  }
}
