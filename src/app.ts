import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestId } from "./middleware/requestId.js";
import { requestTiming } from "./middleware/requestTiming.js";
import { v1Router } from "./routes/v1/index.js";

/**
 * Fase 5.2 — the HTTP application only: no `listen`, no background worker.
 * `server.ts` (a long-running Node process) and `api/index.js` (the Vercel
 * Function) both serve this same app; the webhook retry worker runs in its
 * own process (`worker.ts`), never inside a request-scoped Function.
 */
export const app = express();

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

export default app;
