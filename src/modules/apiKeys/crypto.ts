import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * `ulk_` (UL Key) makes an API key unambiguously distinguishable from a
 * Supabase JWT at a glance — a JWT is 3 dot-separated base64url segments
 * with no fixed prefix; this is a fixed prefix followed by exactly one
 * dot. `authenticate` branches on this prefix rather than shape-sniffing.
 */
const PREFIX = "ulk_";
const SECRET_BYTES = 32; // 256 bits — see README "API Keys" for why this needs no password-style KDF
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

export function generateApiKeySecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/**
 * Plain SHA-256, deliberately not bcrypt/scrypt/argon2: those algorithms'
 * expensive work factor exists to slow down brute-forcing a *low-entropy*
 * human password. This secret has 256 bits of entropy from a CSPRNG —
 * already computationally infeasible to brute-force or rainbow-table
 * regardless of hash speed — so a slow KDF would only add CPU cost to
 * every authenticated request for no real security gain.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison — avoids leaking hash-match progress via timing. */
export function secretMatchesHash(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKeySecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function buildApiKeyToken(id: string, secret: string): string {
  return `${PREFIX}${id}.${secret}`;
}

/** `id` is the public key identifier (safe to expose, used for the O(1) DB lookup) — never confuse it with `secret`. */
export function parseApiKeyToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex <= 0) return null;

  const id = rest.slice(0, dotIndex);
  const secret = rest.slice(dotIndex + 1);
  if (!secret || !UUID_RE.test(id)) return null;

  return { id, secret };
}
