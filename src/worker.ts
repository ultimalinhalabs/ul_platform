import { sql } from "drizzle-orm";
import { env } from "./config/env.js";
import { db, queryClient } from "./db/index.js";
import { startWebhookRetryWorker } from "./modules/webhooks/delivery.js";
import { logger } from "./shared/logger.js";

/**
 * Fase 5.2 — the persistent worker process (Railway in production; `npm run
 * dev:worker` locally). It runs ONLY the webhook retry engine: no HTTP
 * server. All retry state lives in PostgreSQL (`webhook_deliveries`), claims
 * use FOR UPDATE SKIP LOCKED + a lease, so restarts, redeploys and several
 * replicas are safe.
 */

// Fail fast on a wrong DATABASE_URL: exiting non-zero lets the platform's
// restart policy and alerting see it, instead of a worker that "runs" but
// never reaches the database.
try {
  await db.execute(sql`select 1`);
} catch (error) {
  logger.error("Worker could not reach the database", {
    event: "worker.startup.db_error",
    errorCode: error instanceof Error ? error.name : "unknown",
  });
  await queryClient.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

const worker = startWebhookRetryWorker();
logger.info("UL Platform worker started", { event: "worker.started", workerId: worker.workerId, environment: env.APP_ENV });

const SHUTDOWN_TIMEOUT_MS = 30_000;
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Worker shutdown signal received", { event: "worker.shutdown.start", signal, workerId: worker.workerId });

  const forceExitTimer = setTimeout(() => {
    logger.error("Worker shutdown timed out — forcing exit", { event: "worker.shutdown.timeout" });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  void worker
    .stop()
    .then(() => queryClient.end({ timeout: 5 }))
    .catch((error) => {
      logger.error("Error during worker shutdown", {
        event: "worker.shutdown.error",
        errorCode: error instanceof Error ? error.name : "unknown",
      });
    })
    .finally(() => {
      clearTimeout(forceExitTimer);
      logger.info("Worker shutdown complete", { event: "worker.shutdown.complete" });
      process.exit(0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
