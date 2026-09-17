import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`, hex-encoded. Signs the
 * exact transmitted payload bytes (`rawBody`, already-serialized JSON) —
 * deliberately not a re-serialization of a parsed object, which could
 * silently reorder keys/change whitespace and make the receiver's
 * independently-computed signature disagree for reasons that have nothing
 * to do with tampering. The timestamp is part of the signed material so a
 * captured request can't be replayed indefinitely (see `verifyWebhookSignature`).
 */
export function signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Five minutes — generous enough for normal clock drift/network latency, tight enough that a captured request goes stale quickly. Receivers should apply their own tolerance; this is the platform's reference implementation, not an enforced global policy. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a signature was produced by this secret for this exact payload,
 * within a freshness window. This alone is NOT replay protection — it only
 * proves "signed by this secret, recently"; the caller/consumer is still
 * responsible for tracking event IDs it has already processed (see
 * README "Idempotency" — delivery is at-least-once, consumers must
 * tolerate duplicates).
 */
export function verifyWebhookSignature(params: {
  secret: string;
  timestamp: number;
  rawBody: string;
  signature: string;
  toleranceSeconds?: number;
}): boolean {
  const { secret, timestamp, rawBody, signature, toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS } =
    params;

  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = signWebhookPayload(secret, timestamp, rawBody);

  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    providedBuf = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
