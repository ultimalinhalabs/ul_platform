import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "../../config/env.js";

const hs256Secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

/**
 * Supabase's current default for new projects signs access tokens
 * asymmetrically (ES256, occasionally RS256) with a rotating key published
 * at this JWKS endpoint — never a shared secret UL Platform could hold.
 * `createRemoteJWKSet` caches keys and handles rotation by `kid`.
 * `SUPABASE_JWT_SECRET`/HS256 remains supported below for a project still on
 * the legacy shared-secret signing method; which path runs is decided per
 * token from its own header, never from project-wide config, so both kinds
 * of Supabase project work against the same deployment.
 */
const jwks = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", env.SUPABASE_URL));

const supabaseClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email().optional(),
  aud: z.union([z.string(), z.array(z.string())]),
  role: z.string().optional(),
});

export type SupabaseClaims = z.infer<typeof supabaseClaimsSchema>;

export class InvalidTokenError extends Error {}

/**
 * Verifies a Supabase Auth access token server-side, with no network call
 * to Supabase for an HS256 token, or a cached/rotated JWKS fetch for an
 * asymmetrically-signed one. Throws InvalidTokenError on any signature,
 * expiry, or claim-shape failure — callers must not distinguish failure
 * reasons in the response.
 */
export async function verifySupabaseAccessToken(token: string): Promise<SupabaseClaims> {
  try {
    const { alg } = decodeProtectedHeader(token);
    const { payload } =
      alg === "HS256"
        ? await jwtVerify(token, hs256Secret, { algorithms: ["HS256"] })
        : await jwtVerify(token, jwks);
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
