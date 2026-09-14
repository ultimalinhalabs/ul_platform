import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { v1Router } from "./routes/v1/index.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

app.use("/v1", v1Router);

app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`UL Platform listening on port ${env.PORT} (${env.NODE_ENV})`);
});
