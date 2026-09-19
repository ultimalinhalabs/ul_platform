import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { v1Router } from "./routes/v1/index.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
/**
 * Browser clients (UL Console) send `Authorization: Bearer <JWT>` directly —
 * see config/env.ts's PLATFORM_ALLOWED_ORIGINS for why this is an explicit
 * allow-list, never a wildcard. Service-to-service (API key) callers never
 * run in a browser and are unaffected either way.
 */
app.use(
  cors({
    origin: env.PLATFORM_ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use("/v1", v1Router);

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`UL Platform listening on port ${env.PORT} (${env.NODE_ENV})`);
});
