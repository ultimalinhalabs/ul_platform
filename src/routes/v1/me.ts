import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { listMembershipsForUser } from "../../modules/memberships/service.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

export const meRouter = Router();

meRouter.get("/me", authenticate, async (req, res, next) => {
  try {
    if (!req.auth) throw new UnauthorizedError();

    const memberships = await listMembershipsForUser(req.auth.userId);
    ok(res, {
      userId: req.auth.userId,
      email: req.auth.email,
      memberships,
    });
  } catch (error) {
    next(error);
  }
});
