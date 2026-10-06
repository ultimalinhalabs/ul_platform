import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db/index.js";
import { proposalAccessLinks, proposals, proposalVersions } from "../../db/schema/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { type CommercialActor, recordCommercialEvent } from "./events.js";
import type { createAccessLinkSchema } from "./schemas.js";
import { accessLinkDto } from "./serializers.js";
import { generateLinkToken, hashLinkToken, LINK_TOKEN_PATTERN } from "./tokens.js";

/**
 * Block 1B — read-only public access to a SENT proposal. A link is NOT
 * authentication, authorization, a session, a membership or an acceptance:
 * it only lets whoever holds it read the latest sent version. The token is
 * returned once at creation and stored only as SHA-256; it is never logged
 * (events/audit carry the link id, never the token).
 */

/** Proposal states whose sent content may be read through a link. */
const READABLE_PROPOSAL_STATUSES = new Set(["sent", "viewed", "negotiation", "accepted"]);
const LINKABLE_PROPOSAL_STATUSES = new Set(["sent", "viewed", "negotiation"]);

/** One message for every way a token can fail (unknown, malformed, expired, revoked, exhausted, withdrawn…): no oracle. */
const UNAVAILABLE = "This proposal link is not available";

async function currentSentVersion(executor: Pick<typeof db, "select">, proposalId: string) {
  const [version] = await executor
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.status, "sent")))
    .limit(1);
  return version ?? null;
}

export async function listAccessLinks(proposalId: string) {
  const [proposal] = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) throw new NotFoundError("Proposal not found");
  const rows = await db.select().from(proposalAccessLinks).where(eq(proposalAccessLinks.proposalId, proposalId)).orderBy(desc(proposalAccessLinks.createdAt));
  return rows.map(accessLinkDto);
}

/** Creates a recipient link for the currently sent version. `expiresAt` defaults to, and may never exceed, the version's `valid_until`. */
export async function createAccessLink(proposalId: string, input: z.infer<typeof createAccessLinkSchema>, actor: CommercialActor) {
  const { token, tokenSha256 } = generateLinkToken();
  const link = await db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).for("update");
    if (!proposal) throw new NotFoundError("Proposal not found");
    if (!LINKABLE_PROPOSAL_STATUSES.has(proposal.status)) throw new ConflictError(`Links cannot be created for a ${proposal.status} proposal`);
    const version = await currentSentVersion(tx, proposalId);
    if (!version || !version.validUntil) throw new ConflictError("Links can only be created for a sent proposal version");
    const now = Date.now();
    if (version.validUntil.getTime() <= now) throw new ConflictError("The sent version is no longer valid");
    const expiresAt = input.expiresAt ?? version.validUntil;
    if (expiresAt.getTime() > version.validUntil.getTime()) throw new ValidationError("expiresAt cannot be later than the version's valid_until");
    if (expiresAt.getTime() <= now) throw new ValidationError("expiresAt must be in the future");
    const [row] = await tx
      .insert(proposalAccessLinks)
      .values({
        proposalId,
        tokenSha256,
        kind: "recipient",
        recipientEmail: proposal.recipientEmail,
        expiresAt,
        maxViews: input.maxViews ?? null,
        createdBy: actor.userId,
      })
      .returning();
    await recordCommercialEvent(tx, {
      aggregateType: "proposal_access_link",
      aggregateId: row!.id,
      eventType: "proposal.access_link.created",
      organizationId: proposal.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      payload: { proposalId, versionId: version.id, expiresAt: expiresAt.toISOString(), maxViews: input.maxViews ?? null },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.userId,
        organizationId: proposal.organizationId ?? undefined,
        action: "platform.commercial.access_link.created",
        targetType: "proposal_access_link",
        targetId: row!.id,
        metadata: { proposalNumber: proposal.number, expiresAt: expiresAt.toISOString() },
      },
      tx,
    );
    return row!;
  });
  // The token leaves the platform exactly once, here; only its hash was stored.
  return { link: accessLinkDto(link), token, path: `/p/${token}` };
}

/** Revocation is final and idempotent (revoking an already revoked link returns it unchanged). */
export async function revokeAccessLink(proposalId: string, linkId: string, actor: CommercialActor) {
  const link = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(proposalAccessLinks)
      .where(and(eq(proposalAccessLinks.id, linkId), eq(proposalAccessLinks.proposalId, proposalId)))
      .for("update");
    if (!row) throw new NotFoundError("Access link not found");
    if (row.revokedAt) return row;
    const [proposal] = await tx.select({ organizationId: proposals.organizationId, number: proposals.number }).from(proposals).where(eq(proposals.id, proposalId));
    const [updated] = await tx
      .update(proposalAccessLinks)
      .set({ revokedAt: sql`now()`, revokedBy: actor.userId, updatedAt: sql`now()` })
      .where(eq(proposalAccessLinks.id, linkId))
      .returning();
    await recordCommercialEvent(tx, {
      aggregateType: "proposal_access_link",
      aggregateId: linkId,
      eventType: "proposal.access_link.revoked",
      organizationId: proposal?.organizationId ?? null,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      idempotencyKey: `proposal.access_link.revoked:${linkId}`,
      payload: { proposalId },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.userId,
        organizationId: proposal?.organizationId ?? undefined,
        action: "platform.commercial.access_link.revoked",
        targetType: "proposal_access_link",
        targetId: linkId,
        metadata: { proposalNumber: proposal?.number },
      },
      tx,
    );
    return updated!;
  });
  return accessLinkDto(link);
}

type Snapshot = {
  proposal: { number: string; prospectCompanyName: string; prospectTaxId: string | null; recipientName: string };
  version: { versionNo: number; currency: string; validUntil: string | null; summary: string | null };
  terms: { key: string; version: number; title: string; body: string };
  options: Array<{
    name: string;
    summary: string | null;
    isRecommended: boolean;
    totalMinor: string;
    items: Array<{
      kind: string;
      title: string;
      description: string | null;
      application: { name: string } | null;
      plan: { name: string } | null;
      quantity: number;
      unitPriceMinor: string;
      lineTotalMinor: string;
      billingPeriod: string;
      durationMonths: number | null;
    }>;
  }>;
};

/**
 * Public projection of the frozen snapshot: only what the recipient needs to
 * read the proposal. No internal ids, organization, actors, hashes, tokens,
 * recipient email, entitlement specs or internal notes. Acceptance is
 * explicitly unavailable through a link.
 */
export function publicProposalView(snapshot: Snapshot) {
  return {
    proposal: {
      number: snapshot.proposal.number,
      prospectCompanyName: snapshot.proposal.prospectCompanyName,
      prospectTaxId: snapshot.proposal.prospectTaxId,
      recipientName: snapshot.proposal.recipientName,
    },
    version: {
      versionNo: snapshot.version.versionNo,
      currency: snapshot.version.currency,
      validUntil: snapshot.version.validUntil,
      summary: snapshot.version.summary,
    },
    terms: { title: snapshot.terms.title, version: snapshot.terms.version, body: snapshot.terms.body },
    options: snapshot.options.map((o) => ({
      name: o.name,
      summary: o.summary,
      isRecommended: o.isRecommended,
      totalMinor: o.totalMinor,
      items: o.items.map((i) => ({
        kind: i.kind,
        title: i.title,
        description: i.description,
        application: i.application ? { name: i.application.name } : null,
        plan: i.plan ? { name: i.plan.name } : null,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.lineTotalMinor,
        billingPeriod: i.billingPeriod,
        durationMonths: i.durationMonths,
      })),
    })),
    acceptance: { available: false as const },
  };
}

/**
 * Resolves a public token to the latest sent version. Every failure is the
 * same 404. A successful read counts a view; the FIRST view of a link is a
 * business fact (`proposal.viewed`, proposal `sent` → `viewed`). No session,
 * cookie or credential is issued.
 */
export async function resolvePublicProposal(token: string, context: { requestId?: string }) {
  if (!LINK_TOKEN_PATTERN.test(token)) throw new NotFoundError(UNAVAILABLE);
  const tokenSha256 = hashLinkToken(token);
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(proposalAccessLinks).where(eq(proposalAccessLinks.tokenSha256, tokenSha256)).for("update");
    if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw new NotFoundError(UNAVAILABLE);
    if (link.maxViews !== null && link.viewCount >= link.maxViews) throw new NotFoundError(UNAVAILABLE);
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, link.proposalId)).for("update");
    if (!proposal || !READABLE_PROPOSAL_STATUSES.has(proposal.status)) throw new NotFoundError(UNAVAILABLE);
    const version = await currentSentVersion(tx, proposal.id);
    if (!version?.snapshot || !version.validUntil || version.validUntil.getTime() <= Date.now()) throw new NotFoundError(UNAVAILABLE);

    const firstView = link.viewCount === 0;
    await tx
      .update(proposalAccessLinks)
      .set({
        viewCount: sql`${proposalAccessLinks.viewCount} + 1`,
        lastViewedAt: sql`now()`,
        ...(firstView ? { firstViewedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(proposalAccessLinks.id, link.id));
    if (firstView) {
      if (proposal.status === "sent") {
        await tx.update(proposals).set({ status: "viewed", updatedAt: sql`now()` }).where(eq(proposals.id, proposal.id));
      }
      await recordCommercialEvent(tx, {
        aggregateType: "proposal",
        aggregateId: proposal.id,
        eventType: "proposal.viewed",
        organizationId: proposal.organizationId,
        actorType: "public_link",
        correlationId: context.requestId,
        idempotencyKey: `proposal.viewed:${link.id}`,
        payload: { linkId: link.id, versionId: version.id },
      });
    }
    return publicProposalView(version.snapshot as Snapshot);
  });
}
