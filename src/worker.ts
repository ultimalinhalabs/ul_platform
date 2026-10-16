import { sql } from "drizzle-orm";
import { env } from "./config/env.js";
import { db, queryClient } from "./db/index.js";
import { expireDueContracts } from "./modules/commercial/activation.service.js";
import { prepareDueRenewals } from "./modules/commercial/renewals.service.js";
import { deliverDueEmails, smtpConfigured } from "./modules/email/outbox.js";
import { startWebhookRetryWorker } from "./modules/webhooks/delivery.js";
import { logger } from "./shared/logger.js";

/**
 * Fase 5.2 — the persistent worker process (Railway in production; `npm run
 * dev:worker` locally). It runs the webhook retry engine and (migration 0023)
 * the contract expiry sweep, the renewal sweep (0026) and email delivery (0028): no HTTP server. All retry state lives in PostgreSQL (`webhook_deliveries`), claims
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

// Persists contract/grant expiry (access already stops at read time; this keeps the stored state honest).
// Row-locked per contract with SKIP LOCKED, so several replicas are safe; errors are logged, never fatal.
const expiryTimer = setInterval(() => {
  void expireDueContracts()
    .then(({ expired }) => {
      if (expired.length > 0) logger.info("Expired contracts", { event: "commercial.contracts.expired", count: expired.length });
    })
    .catch((error) => logger.error("Contract expiry sweep failed", { event: "commercial.expiry.error", errorCode: error instanceof Error ? error.name : "unknown" }));
}, env.CONTRACT_EXPIRY_SWEEP_INTERVAL_MS);
expiryTimer.unref();

// Migration 0026 — prepares the next period (awaiting payment) of contracts with a standing renewal authorization.
const renewalTimer = setInterval(() => {
  void prepareDueRenewals()
    .then(({ created }) => {
      if (created.length > 0) logger.info("Prepared renewals", { event: "commercial.renewals.prepared", count: created.length });
    })
    .catch((error) => logger.error("Renewal sweep failed", { event: "commercial.renewals.error", errorCode: error instanceof Error ? error.name : "unknown" }));
}, env.RENEWAL_SWEEP_INTERVAL_MS);
renewalTimer.unref();

// Migration 0028 — transactional email delivery (SMTP). Without SMTP_HOST messages stay pending, nothing is lost.
if (!smtpConfigured()) logger.warn("SMTP is not configured: emails stay queued", { event: "email.smtp.unconfigured" });
let emailBusy = false;
const emailTimer = setInterval(() => {
  if (emailBusy) return;
  emailBusy = true;
  void deliverDueEmails()
    .then((r) => {
      if (r.sent || r.failed || r.retried) logger.info("Email delivery", { event: "email.delivery", ...r });
    })
    .catch((error) => logger.error("Email sweep failed", { event: "email.sweep.error", errorCode: error instanceof Error ? error.name : "unknown" }))
    .finally(() => {
      emailBusy = false;
    });
}, env.EMAIL_SWEEP_INTERVAL_MS);
emailTimer.unref();
logger.info("UL Platform worker started", { event: "worker.started", workerId: worker.workerId, environment: env.APP_ENV });

const SHUTDOWN_TIMEOUT_MS = 30_000;
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(expiryTimer);
  clearInterval(renewalTimer);
  clearInterval(emailTimer);
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
