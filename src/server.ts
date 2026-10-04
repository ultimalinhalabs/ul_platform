import { app } from "./app.js";
import { env } from "./config/env.js";
import { queryClient } from "./db/index.js";
import { logger } from "./shared/logger.js";

/**
 * Long-running HTTP server (local development, or any host that runs a plain
 * Node process). Fase 5.2: the webhook retry worker is NOT started here any
 * more — it runs as its own process (`worker.ts`, Railway in production) so
 * the API can also run as a Vercel Function without a background loop.
 */
const server = app.listen(env.PORT, () => {
  logger.info("UL Platform listening", { event: "server.started", port: env.PORT, environment: env.APP_ENV });
});

/**
 * Graceful shutdown (Fase 16 §23): stop accepting new connections, let
 * in-flight requests finish, close the DB pool, then exit — with a hard
 * ceiling so a stuck connection can never hang the process indefinitely.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown signal received", { event: "server.shutdown.start", signal });

  const forceExitTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit", { event: "server.shutdown.timeout" });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  server.close(() => {
    void queryClient
      .end({ timeout: 5 })
      .catch((error) => {
        logger.error("Error while closing DB pool", {
          event: "server.shutdown.db_error",
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        clearTimeout(forceExitTimer);
        logger.info("Shutdown complete", { event: "server.shutdown.complete" });
        process.exit(0);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
