import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Reversible, unlike `modules/apiKeys/crypto.ts`'s one-way SHA-256 hash.
 * An API key only ever needs to be *verified* (does the presented secret
 * match the stored hash?); a webhook secret must also be *retrieved* later,
 * because the platform itself produces the outbound HMAC signature — a
 * hash cannot be reversed to do that. AES-256-GCM (authenticated encryption,
 * not a plain cipher) so a tampered ciphertext fails to decrypt rather than
 * silently producing garbage that would then sign requests wrong.
 *
 * `WEBHOOK_SECRET_ENCRYPTION_KEY` is a platform-held key (env, never in
 * source — see CLAUDE.md §11), completely separate from anything derived
 * from the webhook secret itself or from API-key material.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const SECRET_PREFIX = "whsec_";

function getEncryptionKey(): Buffer {
  const key = Buffer.from(env.WEBHOOK_SECRET_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  return key;
}

/** Shown exactly once, at creation — never persisted in this form. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function encryptWebhookSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Only ever called server-side, immediately before signing an outbound delivery — never returned in any API response. */
export function decryptWebhookSecret(encrypted: string): string {
  const parts = encrypted.split(":");
  const [ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted webhook secret");
  }

  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
