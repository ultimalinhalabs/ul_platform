import { jwtVerify } from "jose";
import { z } from "zod";
import { env } from "../../config/env.js";

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

const supabaseClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email().optional(),
  aud: z.union([z.string(), z.array(z.string())]),
  role: z.string().optional(),
});

export type SupabaseClaims = z.infer<typeof supabaseClaimsSchema>;

export class InvalidTokenError extends Error {}

/**
 * Verifies a Supabase Auth access token server-side (HS256 shared secret),
 * with no network call to Supabase. Throws InvalidTokenError on any
 * signature, expiry, or claim-shape failure — callers must not distinguish
 * failure reasons in the response.
 */
export async function verifySupabaseAccessToken(token: string): Promise<SupabaseClaims> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const claims = supabaseClaimsSchema.parse(payload);

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes("authenticated")) {
      throw new InvalidTokenError("Unexpected audience");
    }

    return claims;
  } catch (error) {
    if (error instanceof InvalidTokenError) throw error;
    throw new InvalidTokenError("Invalid or expired access token");
  }
}
