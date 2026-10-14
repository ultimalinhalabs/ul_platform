import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requireServiceScope } from "../../middleware/requireServiceScope.js";
import { createLeadSchema, idempotencyKeySchema } from "../../modules/leads/schemas.js";
import { createLead } from "../../modules/leads/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { ForbiddenError, ValidationError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

/**
 * Lead intake for Última Linha's own commercial pipeline. Server-to-server
 * only: the landing's backend calls this with a PLATFORM_SERVICE credential
 * (`lead.create`); the browser never talks to this API, so no CORS origin
 * and no public endpoint are involved. The source application is the
 * credential's own stored application — there is no body field to spoof it.
 *
 * Organization credentials are refused even if a scope allowlist ever
 * granted them `lead.create`: a lead is addressed to UL, not to a tenant.
 * Sending the notification/auto-reply emails stays with the caller (the
 * landing's SMTP) — UL Platform stores the lead; it does not communicate.
 */
export const leadsRouter = Router();

leadsRouter.post(
  "/service/leads",
  authenticate,
  requireServiceScope("lead.create"),
  rateLimit({ keyPrefix: "service.leads.create", windowMs: 60_000, max: 30 }),
  asyncHandler(async (req, res) => {
    if (req.service!.credentialClass !== "PLATFORM_SERVICE") {
      throw new ForbiddenError("Leads can only be submitted with a platform service credential");
    }
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!key.success) throw new ValidationError("A valid Idempotency-Key header is required");

    const result = await createLead({
      applicationKey: req.service!.applicationKey,
      apiKeyId: req.service!.apiKeyId,
      idempotencyKey: key.data,
      lead: createLeadSchema.parse(req.body),
    });
    res.set("Cache-Control", "no-store");
    ok(res, result, result.idempotent ? 200 : 201);
  }),
);
