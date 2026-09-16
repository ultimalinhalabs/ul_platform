import type { NextFunction, Request, Response } from "express";
import { verifySupabaseAccessToken } from "../integrations/supabase/jwt.js";
import { isApiKeyToken } from "../modules/apiKeys/crypto.js";
import { verifyApiKeyToken } from "../modules/apiKeys/service.js";
import { ensureUserExists } from "../modules/users/service.js";
import { UnauthorizedError } from "../shared/errors.js";

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
 * authorization/tenant checks happen in later middleware, not here.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req.header("authorization"));

    if (isApiKeyToken(token)) {
      req.service = await verifyApiKeyToken(token);
      return next();
    }

    const claims = await verifySupabaseAccessToken(token).catch(() => {
      throw new UnauthorizedError("Invalid or expired access token");
    });

    await ensureUserExists({ id: claims.sub, email: claims.email });

    req.auth = { userId: claims.sub, email: claims.email };
    next();
  } catch (error) {
    next(error);
  }
}
