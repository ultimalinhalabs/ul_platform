import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { queryClient } from "./db/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestId } from "./middleware/requestId.js";
import { requestTiming } from "./middleware/requestTiming.js";
import { v1Router } from "./routes/v1/index.js";
import { logger } from "./shared/logger.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
/**
 * Browser clients (UL Console) send `Authorization: Bearer <JWT>` directly —
 * see config/env.ts's PLATFORM_ALLOWED_ORIGINS for why this is an explicit
 * allow-list, never a wildcard. Service-to-service (API key) callers never
 * run in a browser and are unaffected either way. `exposedHeaders` lets a
 * browser client's own JS read `X-Request-ID` back (CORS hides response
 * headers from JS by default outside a small safelist).
 */
app.use(
  cors({
    origin: env.PLATFORM_ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
    exposedHeaders: ["X-Request-ID"],
  }),
);
// First-in-first-out ordering matters: requestId before requestTiming (which logs it),
// and both before body parsing/routes so every downstream log/response carries it.
app.use(requestId);
app.use(requestTiming);
app.use(express.json({ limit: "1mb" }));

app.use("/v1", v1Router);

app.use(errorHandler);

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
