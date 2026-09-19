import type { NextFunction, Request, Response } from "express";
import { fail } from "../shared/response.js";

/**
 * A minimal in-memory, per-process rate limiter (Fase 16 §21). Deliberately
 * NOT Redis-backed: this deployment is a single instance, and a
 * distributed limiter would be complexity with no present payoff — see
 * README "Rate Limiting" for the documented limitation this implies (a
 * multi-instance deployment would need a real fix here, not more of this).
 *
 * Applied selectively to the operations Fase 16 names as priority
 * (credential issuance/revocation, webhook test delivery, service
 * discovery) — never to health endpoints, where rate-limiting legitimate
 * load-balancer/orchestrator polling could itself cause a false
 * "unhealthy" cascade.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Bounds unbounded growth from many distinct callers over a long uptime —
// expired buckets are swept periodically rather than checked one-by-one on
// every request.
const SWEEP_INTERVAL_MS = 5 * 60_000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

export function rateLimit({ windowMs, max, keyPrefix }: { windowMs: number; max: number; keyPrefix: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Best-effort caller identity: the authenticated actor when known
    // (survives IP changes/shared NATs), falling back to req.ip.
    const identity = req.auth?.userId ?? req.service?.apiKeyId ?? req.ip ?? "unknown";
    const key = `${keyPrefix}:${identity}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return fail(res, 429, "RATE_LIMITED", "Too many requests — please slow down and try again shortly.");
    }

    next();
  };
}
