import type { NextFunction, Request, Response } from "express";
import { verifySupabaseAccessToken } from "../integrations/supabase/jwt.js";
import { ensureUserExists } from "../modules/users/service.js";
import { UnauthorizedError } from "../shared/errors.js";

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  return header.slice("Bearer ".length).trim();
}

/**
 * Verifies the caller's Supabase-issued JWT and attaches `req.auth`.
 * This is the only place a request establishes "who is the current user" —
 * authorization/tenant checks happen in later middleware, not here.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req.header("authorization"));
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
