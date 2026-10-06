import { Router } from "express";
import { rateLimit } from "../../middleware/rateLimit.js";
import { resolvePublicProposal } from "../../modules/commercial/accessLinks.service.js";
import { resolvePublicProposalSchema } from "../../modules/commercial/schemas.js";
import { asyncHandler } from "../../shared/asyncHandler.js";
import { NotFoundError } from "../../shared/errors.js";
import { ok } from "../../shared/response.js";

/**
 * Block 1B — the only unauthenticated commercial endpoint: read a SENT
 * proposal through a link token. The token travels in the BODY (request logs
 * record only the path), never in the URL of this API.
 *
 * Abuse defences, in order of strength:
 *  1. 256-bit random tokens stored as SHA-256 — enumeration is infeasible;
 *  2. one uniform 404 for every failure (malformed, unknown, expired,
 *     revoked, exhausted, withdrawn) — no oracle;
 *  3. the existing in-memory `rateLimit` (per process, keyed by `req.ip`).
 *     LIMITATION (documented, not worked around): `trust proxy` is NOT set
 *     (deliberately — it would change req.ip for every route), so behind
 *     Vercel `req.ip` is not guaranteed to be the real client; the bucket may
 *     be shared by many clients of the same instance, and each serverless
 *     instance has its own buckets. A per-client limit needs infrastructure
 *     (e.g. platform firewall rules) and is out of scope for this block.
 *
 * Responses are never cached or indexed. No session, cookie or credential is
 * issued; acceptance is not possible here.
 */
export const publicProposalsRouter = Router();

publicProposalsRouter.post(
  "/public/proposals/resolve",
  rateLimit({ keyPrefix: "public.proposal.resolve", windowMs: 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    const parsed = resolvePublicProposalSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new NotFoundError("This proposal link is not available");
    ok(res, await resolvePublicProposal(parsed.data.token, { requestId: req.requestId }));
  }),
);
