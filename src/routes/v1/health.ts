import { sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/index.js";
import { logger } from "../../shared/logger.js";
import { fail, ok } from "../../shared/response.js";

export const healthRouter = Router();

/**
 * Liveness — "is the process alive?" Deliberately has zero dependencies
 * (no DB, no Supabase) — see Fase 16 §18: if PostgreSQL goes down, this
 * must keep answering 200. A liveness probe that depends on a downstream
 * service causes exactly the wrong reaction from an orchestrator (killing
 * and restarting a perfectly healthy process instead of leaving it up
 * while only the *readiness* probe fails).
 */
healthRouter.get("/health", (_req, res) => {
  ok(res, { status: "ok" });
});

/**
 * Readiness — "should this instance receive traffic?" Checks the one
 * dependency every route needs (PostgreSQL) with the cheapest possible
 * query. Never returns host/connection-string/driver error detail — a
 * caller (load balancer, orchestrator, or an operator's curl) only ever
 * needs "ready" or "not ready", never why in the response body itself
 * (the real reason goes to the structured log, keyed by requestId).
 */
healthRouter.get("/health/ready", async (req, res) => {
  try {
    await db.execute(sql`select 1`);
    ok(res, { status: "ready" });
  } catch (error) {
    logger.error("readiness check failed", {
      requestId: req.requestId,
      event: "health.not_ready",
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    fail(res, 503, "NOT_READY", "Not ready to receive traffic");
  }
});
