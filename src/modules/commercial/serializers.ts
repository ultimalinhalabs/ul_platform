import type { proposalAccessLinks, proposalItems, proposalOptions, proposals, proposalVersions } from "../../db/schema/index.js";
import { minorToString } from "./money.js";

/**
 * Block 1B — the ONLY place commercial rows become JSON. `bigint` amounts
 * are always turned into decimal strings here (res.json cannot serialize a
 * BigInt). Admin DTOs never include a link token; the public DTO is built
 * only from the frozen snapshot and never includes ids of organizations or
 * actors, hashes, tokens or internal status.
 */
type ProposalRow = typeof proposals.$inferSelect;
type VersionRow = typeof proposalVersions.$inferSelect;
type OptionRow = typeof proposalOptions.$inferSelect;
type ItemRow = typeof proposalItems.$inferSelect;
type LinkRow = typeof proposalAccessLinks.$inferSelect;

export interface ItemRefs {
  applicationKey: string | null;
  planKey: string | null;
}

export function proposalDto(p: ProposalRow) {
  return {
    id: p.id,
    number: p.number,
    status: p.status,
    prospectCompanyName: p.prospectCompanyName,
    prospectTaxId: p.prospectTaxId,
    recipientName: p.recipientName,
    recipientEmail: p.recipientEmail,
    organizationId: p.organizationId,
    ownerUserId: p.ownerUserId,
    currentVersionId: p.currentVersionId,
    acceptedVersionId: p.acceptedVersionId,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function versionSummaryDto(v: VersionRow) {
  return {
    id: v.id,
    proposalId: v.proposalId,
    versionNo: v.versionNo,
    status: v.status,
    currency: v.currency,
    validUntil: v.validUntil,
    summary: v.summary,
    notes: v.notes,
    termsTemplateId: v.termsTemplateId,
    contentSha256: v.contentSha256,
    hashAlg: v.hashAlg,
    sentAt: v.sentAt,
    sentBy: v.sentBy,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export function itemDto(i: ItemRow, refs: ItemRefs) {
  return {
    id: i.id,
    optionId: i.optionId,
    sort: i.sort,
    kind: i.kind,
    title: i.title,
    description: i.description,
    applicationKey: refs.applicationKey,
    planKey: refs.planKey,
    quantity: i.quantity,
    unitPriceMinor: minorToString(i.unitPriceMinor),
    lineTotalMinor: minorToString(i.lineTotalMinor),
    billingPeriod: i.billingPeriod,
    durationMonths: i.durationMonths,
    entitlementSpec: i.entitlementSpec,
  };
}

export function optionDto(o: OptionRow, items: ReturnType<typeof itemDto>[]) {
  return {
    id: o.id,
    versionId: o.versionId,
    sort: o.sort,
    name: o.name,
    summary: o.summary,
    isRecommended: o.isRecommended,
    totalMinor: minorToString(o.totalMinor),
    items,
  };
}

/** Admin view of a link — the token is never stored, so it can never be shown again. */
export function accessLinkDto(l: LinkRow) {
  return {
    id: l.id,
    proposalId: l.proposalId,
    kind: l.kind,
    recipientEmail: l.recipientEmail,
    expiresAt: l.expiresAt,
    maxViews: l.maxViews,
    viewCount: l.viewCount,
    firstViewedAt: l.firstViewedAt,
    lastViewedAt: l.lastViewedAt,
    revokedAt: l.revokedAt,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
  };
}
