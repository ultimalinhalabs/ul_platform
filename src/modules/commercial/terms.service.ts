import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { commercialTermsTemplates } from "../../db/schema/index.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { recordAuditEventStrict } from "../audit/service.js";
import { sha256Hex } from "./canonicalJson.js";
import { type CommercialActor, recordCommercialEvent } from "./events.js";

/**
 * Terms approval from the UL Console (owner decision 2026-10-18). Approval is a platform act: a PLATFORM member
 * holding `platform.terms.approve` (migration 0030) confirms the EXACT text read — the request carries the SHA-256
 * shown with it, so a text changed in the meantime is never approved by mistake. A text that still carries draft
 * markers or placeholders is refused. Once approved the row is frozen by the 0016 trigger; a new text = new version.
 */
export function draftMarkers(body: string): string[] {
  const found: string[] = [];
  const checks: [string, RegExp][] = [
    ["RASCUNHO", /RASCUNHO/i],
    ["placeholder […]", /\[[^\]]{1,80}\]/],
    ["a completar", /a completar/i],
    ["a preencher", /a preencher/i],
    ["serão definid(a)s", /ser[ãa]o definid[ao]s/i],
    ["devem ser definidos", /devem ser definid[ao]s/i],
    ["serão validadas", /ser[ãa]o validad[ao]s/i],
    ["sujeitos a confirmação", /sujeit[ao]s a confirma[çc][ãa]o/i],
  ];
  for (const [label, re] of checks) if (re.test(body)) found.push(label);
  return found;
}

export const termsIdParam = z.string().uuid();
export const approveTermsSchema = z.object({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** Full text for reading before approval (platform.commercial.read). */
export async function getPlatformTermsDetail(termsId: string) {
  const [t] = await db.select().from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, termsId));
  if (!t) throw new NotFoundError("Terms not found");
  return {
    id: t.id,
    key: t.key,
    version: t.version,
    title: t.title,
    status: t.status,
    contentSha256: t.bodySha256,
    body: t.body,
    draftMarkers: draftMarkers(t.body),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    approvedAt: t.approvedAt,
    approvedBy: t.approvedBy,
  };
}

export async function approveTerms(termsId: string, input: z.infer<typeof approveTermsSchema>, actor: CommercialActor) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, termsId)).for("update");
    if (!t) throw new NotFoundError("Terms not found");
    if (t.status === "approved" && t.bodySha256 === input.contentSha256) return { replayed: true, terms: await getPlatformTermsDetail(termsId) };
    if (t.status !== "draft") throw new ConflictError(`These terms are ${t.status}; only a draft can be approved`);
    // Defence in depth: the stored hash must still be the hash of the stored text, and the one the approver read.
    if (sha256Hex(t.body) !== t.bodySha256 || t.bodySha256 !== input.contentSha256) {
      throw new AppError(409, "TERMS_CHANGED", "The text changed since it was read; reload it and read it again before approving");
    }
    const markers = draftMarkers(t.body);
    if (markers.length) throw new AppError(409, "TERMS_HAVE_DRAFT_MARKERS", `The text still has draft markers: ${markers.join(", ")}`);
    await tx
      .update(commercialTermsTemplates)
      .set({ status: "approved", approvedBy: actor.userId, approvedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(commercialTermsTemplates.id, termsId), eq(commercialTermsTemplates.status, "draft")));
    await recordCommercialEvent(tx, {
      aggregateType: "terms_template",
      aggregateId: t.id,
      eventType: "terms.approved",
      actorType: "user",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      idempotencyKey: `terms.approved:${t.id}`,
      payload: { key: t.key, version: t.version, contentSha256: t.bodySha256 },
    });
    await recordAuditEventStrict(
      { actorUserId: actor.userId, action: "platform.terms.approved", targetType: "commercial_terms_template", targetId: t.id, metadata: { key: t.key, version: t.version, contentSha256: t.bodySha256 } },
      tx,
    );
    return { replayed: false, terms: null };
  }).then(async (r) => ({ replayed: r.replayed, terms: r.terms ?? (await getPlatformTermsDetail(termsId)) }));
}
