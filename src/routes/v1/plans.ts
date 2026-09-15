import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { getPlanDetail, listPlansForApplication } from "../../modules/plans/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/** Read-only, auth-only — same reasoning as applications.ts/roles.ts/permissions.ts. */
export const plansRouter = Router();

plansRouter.get(
  "/applications/:applicationKey/plans",
  authenticate,
  asyncHandler(async (req, res) => {
    const plans = await listPlansForApplication(paramString(req.params.applicationKey)!);
    ok(res, plans);
  }),
);

plansRouter.get(
  "/applications/:applicationKey/plans/:planKey",
  authenticate,
  asyncHandler(async (req, res) => {
    const detail = await getPlanDetail(
      paramString(req.params.applicationKey)!,
      paramString(req.params.planKey)!,
    );
    ok(res, detail);
  }),
);
