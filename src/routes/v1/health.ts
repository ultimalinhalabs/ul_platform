import { Router } from "express";
import { ok } from "../../shared/response.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  ok(res, { status: "ok" });
});
