import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** A client-supplied X-Request-ID must look like this to be trusted — otherwise it's replaced, never rejected outright (a malformed value is a client bug, not an attack worth a 400 over). */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Establishes `req.requestId` before any other middleware runs (mounted
 * first in server.ts) — every log line and the `X-Request-ID` response
 * header downstream depend on it already being set.
 *
 * Fase 16 §14: a client-supplied `X-Request-ID` is honored only if it
 * passes `VALID_REQUEST_ID` — this lets a caller correlate its own retries
 * across a request, but a client can never inject something unbounded,
 * control-character-laden, or used to smuggle data into log lines. Anything
 * else (absent or invalid) gets a fresh UUID. Never derived from anything
 * secret, and safe to echo back to the caller and to write to logs.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header("x-request-id");
  const id = supplied && VALID_REQUEST_ID.test(supplied) ? supplied : randomUUID();

  req.requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
}
