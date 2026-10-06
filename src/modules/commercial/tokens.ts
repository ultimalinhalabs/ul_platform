import { randomBytes } from "node:crypto";
import { sha256Hex } from "./canonicalJson.js";

/**
 * Block 1B — public proposal link tokens. 32 bytes from the OS CSPRNG,
 * base64url (43 characters). Only the SHA-256 of the token is stored
 * (`proposal_access_links.token_sha256`): a token is never persisted, logged
 * or returned again after creation. With 256 bits of entropy a fast hash is
 * sufficient (no brute-force speed-up exists), which also allows an indexed
 * lookup by hash.
 */
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashLinkToken(token: string): string {
  return sha256Hex(token);
}

export function generateLinkToken(): { token: string; tokenSha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenSha256: hashLinkToken(token) };
}
