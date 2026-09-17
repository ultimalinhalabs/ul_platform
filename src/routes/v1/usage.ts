import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireServiceApplicationMatch } from "../../middleware/requireServiceApplicationMatch.js";
import { requireServiceOrganizationMatch } from "../../middleware/requireServiceOrganizationMatch.js";
import { requireServiceScope } from "../../middleware/requireServiceScope.js";
import { requireUsageReadAccess } from "../../middleware/usageAccess.js";
import { recordUsageSchema, usageRangeQuerySchema } from "../../modules/usage/schemas.js";
import { getUsageForApplication, getUsageForMeter, recordUsage } from "../../modules/usage/service.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";

/**
 * Usage is application-scoped, mirroring Effective Entitlements' URL shape
 * (`/organizations/:id/applications/:key/...`) rather than a top-level
 * `/organizations/:id/usage` — application is a first-class query/write
 * dimension here (CLAUDE.md's metering prompt §21), so it belongs in the
 * path, not an optional query parameter.
 *
 * Writes are service-only (`requireServiceOrganizationMatch` +
 * `requireServiceApplicationMatch` + `usage.write` scope) — there is no
 * human write path, matching Effective Entitlements having no human write
 * path either (usage is a fact a product service reports, not something a
 * human types in). Reads accept both humans and matching service
 * credentials (`requireUsageReadAccess`).
 */
export const usageRouter = Router();

usageRouter.post(
  "/organizations/:organizationId/applications/:applicationKey/usage",
  authenticate,
  requireServiceOrganizationMatch(),
  requireServiceApplicationMatch(),
  requireServiceScope("usage.write"),
  asyncHandler(async (req, res) => {
    const body = recordUsageSchema.parse(req.body);
    const result = await recordUsage({
      organizationId: req.service!.organizationId!,
      applicationKey: req.service!.applicationKey,
      meterKey: body.meterKey,
      quantity: body.quantity,
      occurredAt: body.occurredAt,
      idempotencyKey: body.idempotencyKey,
      metadata: body.metadata,
    });
    // idempotent replay of an existing event is still a success, not a fresh 201
    ok(res, result, result.idempotent ? 200 : 201);
  }),
);

usageRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/usage",
  authenticate,
  requireUsageReadAccess,
  asyncHandler(async (req, res) => {
    const query = usageRangeQuerySchema.parse(req.query);
    const result = await getUsageForApplication({
      organizationId: paramString(req.params.organizationId)!,
      applicationKey: paramString(req.params.applicationKey)!,
      range: { from: query.from, to: query.to },
    });
    ok(res, result);
  }),
);

usageRouter.get(
  "/organizations/:organizationId/applications/:applicationKey/usage/:meterKey",
  authenticate,
  requireUsageReadAccess,
  asyncHandler(async (req, res) => {
    const query = usageRangeQuerySchema.parse(req.query);
    const result = await getUsageForMeter({
      organizationId: paramString(req.params.organizationId)!,
      applicationKey: paramString(req.params.applicationKey)!,
      meterKey: paramString(req.params.meterKey)!,
      range: { from: query.from, to: query.to },
    });
    ok(res, result);
  }),
);
