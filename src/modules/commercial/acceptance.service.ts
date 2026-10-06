import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  commercialTermsTemplates,
  contractItems,
  contracts,
  contractVersions,
  organizations,
  plans,
  proposalAcceptances,
  proposalItems,
  proposalOptions,
  proposals,
  proposalVersions,
  users,
} from "../../db/schema/index.js";
import { ConflictError, ForbiddenError, NotFoundError, OrganizationSuspendedError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { findActiveMembership } from "../memberships/service.js";
import { createOrganization } from "../organizations/service.js";
import { findActivePlatformAdmin } from "../platformAdmins/service.js";
import { isEmailVerified } from "../users/service.js";
import { canonicalSha256 } from "./canonicalJson.js";
import { currentAcceptanceConsent } from "./consent.js";
import { recordCommercialEvent } from "./events.js";
import { currentPlatformLegalIdentity, type PlatformLegalIdentity } from "./legalIdentity.js";
import type { buildVersionSnapshot } from "./proposals.service.js";
import type { acceptProposalSchema } from "./schemas.js";
import { acceptanceDto, contractSummaryDto } from "./serializers.js";

/**
 * Block 1C — acceptance of a sent proposal version by its client, and the
 * contract that is born from it (status `pending_activation`).
 *
 * Authority (decisions D1/D2/D10): ONLY the proposal's recipient, signed in,
 * `active`, with a VERIFIED email equal to `recipient_email`, acting as an
 * ACTIVE OWNER of an ACTIVE organization — the proposal's own organization,
 * or (prospect without one) an organization they own or create right here.
 * A public link authorizes nothing; a platform administrator never accepts.
 *
 * Everything — optional organization creation, acceptance, contract, v1,
 * items, events, audit — is ONE transaction; any failure rolls all back.
 * The contract is a photograph of what was accepted (the frozen proposal
 * snapshot + the platform's legal identity at that moment); nothing is
 * rebuilt from the current catalog. No entitlement, subscription or
 * application access is created here (Block 1D). The platform records
 * technical evidence of the acceptance; it makes no claim of legal validity.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type VersionSnapshot = ReturnType<typeof buildVersionSnapshot>;
type SnapshotOption = VersionSnapshot["options"][number];

export interface AcceptanceActor {
  userId: string;
  userAgent?: string | null;
  requestId?: string;
}

const ACCEPTABLE_PROPOSAL_STATUSES = new Set(["sent", "viewed", "negotiation"]);
const RECIPIENT_VISIBLE_STATUSES = ["sent", "viewed", "negotiation", "accepted"] as const;

// ---------------------------------------------------------------------------- identity

/** The caller's email, only if the identity provider has VERIFIED it (never from user_metadata). */
async function verifiedEmailOf(userId: string): Promise<string> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.email || !(await isEmailVerified(userId))) throw new ForbiddenError("A verified email address is required");
  return user.email.trim().toLowerCase();
}

async function loadRecipientProposal(executor: Pick<typeof db, "select">, proposalId: string, email: string) {
  const [proposal] = await executor
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), sql`lower(${proposals.recipientEmail}) = ${email}`))
    .limit(1);
  // Not the recipient ⇒ the proposal does not exist for this caller (no existence oracle).
  if (!proposal || !(RECIPIENT_VISIBLE_STATUSES as readonly string[]).includes(proposal.status)) throw new NotFoundError("Proposal not found");
  return proposal;
}

async function sentVersionOf(executor: Pick<typeof db, "select">, proposalId: string) {
  const [version] = await executor
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.status, "sent")))
    .limit(1);
  return version ?? null;
}

// ---------------------------------------------------------------------------- recipient reads

export async function listMyProposals(userId: string) {
  const email = await verifiedEmailOf(userId);
  const rows = await db
    .select({ proposal: proposals, version: proposalVersions })
    .from(proposals)
    .leftJoin(proposalVersions, and(eq(proposalVersions.proposalId, proposals.id), eq(proposalVersions.status, "sent")))
    .where(and(sql`lower(${proposals.recipientEmail}) = ${email}`, inArray(proposals.status, [...RECIPIENT_VISIBLE_STATUSES])))
    .orderBy(desc(proposals.createdAt));
  return rows.map(({ proposal, version }) => ({
    id: proposal.id,
    number: proposal.number,
    status: proposal.status,
    prospectCompanyName: proposal.prospectCompanyName,
    version: version ? { id: version.id, versionNo: version.versionNo, currency: version.currency, validUntil: version.validUntil } : null,
  }));
}

/**
 * The recipient's view of a proposal: the frozen snapshot WITH the exact
 * identifiers an acceptance must name (version id, option ids, content hash).
 * Only the verified recipient gets it — this is not the public link view.
 */
export async function getRecipientProposal(proposalId: string, userId: string) {
  const email = await verifiedEmailOf(userId);
  const proposal = await loadRecipientProposal(db, proposalId, email);
  const version = await sentVersionOf(db, proposal.id);
  if (!version?.snapshot) throw new NotFoundError("Proposal not found");
  const snapshot = version.snapshot as VersionSnapshot;
  const [acceptance] = await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, proposal.id)).limit(1);
  const [contract] = acceptance ? await db.select().from(contracts).where(eq(contracts.sourceAcceptanceId, acceptance.id)).limit(1) : [];
  const consent = currentAcceptanceConsent();
  const open = ACCEPTABLE_PROPOSAL_STATUSES.has(proposal.status) && !acceptance && !!version.validUntil && version.validUntil.getTime() > Date.now();
  return {
    proposal: { id: proposal.id, number: proposal.number, status: proposal.status, prospectCompanyName: snapshot.proposal.prospectCompanyName, prospectTaxId: snapshot.proposal.prospectTaxId, recipientName: snapshot.proposal.recipientName, organizationId: proposal.organizationId },
    version: { id: version.id, versionNo: version.versionNo, currency: snapshot.version.currency, validUntil: snapshot.version.validUntil, summary: snapshot.version.summary, contentSha256: version.contentSha256, hashAlg: version.hashAlg },
    terms: { key: snapshot.terms.key, version: snapshot.terms.version, title: snapshot.terms.title, body: snapshot.terms.body },
    options: snapshot.options.map((o) => ({
      id: o.id,
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
    consent: consent.available ? { key: consent.consent.key, version: consent.consent.version, status: consent.consent.status, text: consent.consent.text } : null,
    acceptance: acceptance ? { ...acceptanceDto(acceptance), contractId: contract?.id ?? null } : null,
    acceptable: open && consent.available,
  };
}

// ---------------------------------------------------------------------------- contract photograph

export interface ContractSnapshotInput {
  contractNumber: string;
  proposal: { id: string; number: string };
  version: { id: string; versionNo: number; contentSha256: string; hashAlg: string };
  versionSnapshot: VersionSnapshot;
  option: SnapshotOption;
  acceptance: { id: string; acceptedAt: Date; signerName: string; signerTitle: string | null; signerEmail: string; consentKey: string; consentVersion: number; consentSha256: string };
  provider: PlatformLegalIdentity;
  client: { organizationId: string; organizationName: string };
  renewalPolicy: "none" | "manual";
}

/**
 * Contract version v1 (`ul.commercial.contract-version/1`): origin (proposal,
 * version, content hash, acceptance), the parties as they stood (platform
 * legal identity + client organization + signer), the chosen option and its
 * items with exact money, currency, renewal policy and the terms with their
 * hash. Built ONLY from the frozen proposal snapshot and the acceptance.
 */
export function buildContractVersionSnapshot(input: ContractSnapshotInput) {
  const parties = {
    provider: input.provider,
    client: {
      organization: { id: input.client.organizationId, name: input.client.organizationName },
      companyName: input.versionSnapshot.proposal.prospectCompanyName,
      taxId: input.versionSnapshot.proposal.prospectTaxId ?? null,
      signer: { name: input.acceptance.signerName, title: input.acceptance.signerTitle ?? null, email: input.acceptance.signerEmail },
    },
  };
  const snapshot = {
    schema: "ul.commercial.contract-version/1",
    contract: { number: input.contractNumber, versionNo: 1, currency: input.versionSnapshot.version.currency, totalMinor: input.option.totalMinor, renewalPolicy: input.renewalPolicy },
    source: {
      proposalId: input.proposal.id,
      proposalNumber: input.proposal.number,
      proposalVersionId: input.version.id,
      proposalVersionNo: input.version.versionNo,
      proposalContentSha256: input.version.contentSha256,
      proposalHashAlg: input.version.hashAlg,
      acceptanceId: input.acceptance.id,
      acceptedAt: input.acceptance.acceptedAt.toISOString(),
      consent: { key: input.acceptance.consentKey, version: input.acceptance.consentVersion, sha256: input.acceptance.consentSha256 },
    },
    parties,
    option: { id: input.option.id, name: input.option.name, summary: input.option.summary ?? null, totalMinor: input.option.totalMinor },
    items: input.option.items,
    terms: { ...input.versionSnapshot.terms },
  };
  return { parties, snapshot };
}

// ---------------------------------------------------------------------------- acceptance

type AcceptInput = z.infer<typeof acceptProposalSchema>;

async function existingResult(executor: Pick<typeof db, "select">, acceptanceId: string) {
  const [acceptance] = await executor.select().from(proposalAcceptances).where(eq(proposalAcceptances.id, acceptanceId)).limit(1);
  const [contract] = await executor.select().from(contracts).where(eq(contracts.sourceAcceptanceId, acceptanceId)).limit(1);
  const [version] = contract?.currentVersionId ? await executor.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId)).limit(1) : [];
  return { acceptance: acceptanceDto(acceptance!), contract: contract ? contractSummaryDto(contract, version ?? null) : null };
}

/** Same acceptance = same proposal, version, option, content hash, user and (when named) organization. */
async function isSameAcceptance(executor: Pick<typeof db, "select">, existing: typeof proposalAcceptances.$inferSelect, proposalId: string, input: AcceptInput, userId: string) {
  if (existing.proposalId !== proposalId || existing.versionId !== input.versionId || existing.optionId !== input.optionId) return false;
  if (existing.contentSha256 !== input.contentSha256 || existing.acceptedByUserId !== userId) return false;
  if (!input.organization) return true;
  if ("id" in input.organization) return input.organization.id === existing.organizationId;
  const [org] = await executor.select({ name: organizations.name, createdBy: organizations.createdBy }).from(organizations).where(eq(organizations.id, existing.organizationId));
  return org?.createdBy === userId && org?.name === input.organization.create.name;
}

async function assertOwnerOfActiveOrganization(userId: string, organizationId: string) {
  const membership = await findActiveMembership(userId, organizationId);
  if (!membership) throw new ForbiddenError("Only an active OWNER of the organization can accept this proposal");
  if (membership.organizationStatus !== "active") throw new OrganizationSuspendedError();
  if (membership.roleKey !== "OWNER") throw new ForbiddenError("Only an active OWNER of the organization can accept this proposal");
}

/**
 * Accepts `input.optionId` of `input.versionId` (with `input.contentSha256`)
 * for the verified recipient. Returns `{ created: true }` on the first
 * acceptance (HTTP 201) and the existing result for an identical replay
 * (200); anything else that conflicts is a 409.
 */
export async function acceptProposal(proposalId: string, input: AcceptInput, idempotencyKey: string, actor: AcceptanceActor) {
  const consent = currentAcceptanceConsent();
  if (!consent.available) throw new ConflictError("Proposal acceptance is not available: the official consent statement is not configured");
  if (await findActivePlatformAdmin(actor.userId)) throw new ForbiddenError("Platform administrators cannot accept proposals on behalf of a client");
  const email = await verifiedEmailOf(actor.userId);

  return db.transaction(async (tx: Tx) => {
    // Replay of the same request (same Idempotency-Key): identical ⇒ the stored result; different ⇒ 409.
    const [byKey] = await tx.select().from(proposalAcceptances).where(eq(proposalAcceptances.idempotencyKey, idempotencyKey)).limit(1);
    if (byKey) {
      if (await isSameAcceptance(tx, byKey, proposalId, input, actor.userId)) return { created: false, ...(await existingResult(tx, byKey.id)) };
      throw new ConflictError("This Idempotency-Key was already used for a different acceptance");
    }

    const [locked] = await tx.select().from(proposals).where(and(eq(proposals.id, proposalId), sql`lower(${proposals.recipientEmail}) = ${email}`)).for("update");
    if (!locked || !(RECIPIENT_VISIBLE_STATUSES as readonly string[]).includes(locked.status)) throw new NotFoundError("Proposal not found");

    // A proposal is accepted at most once (UNIQUE proposal_id): an identical second acceptance is idempotent, anything else 409.
    const [already] = await tx.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, proposalId)).limit(1);
    if (already) {
      if (await isSameAcceptance(tx, already, proposalId, input, actor.userId)) return { created: false, ...(await existingResult(tx, already.id)) };
      throw new ConflictError("This proposal has already been accepted");
    }
    if (!ACCEPTABLE_PROPOSAL_STATUSES.has(locked.status)) throw new ConflictError(`A ${locked.status} proposal cannot be accepted`);

    // The EXACT version that was presented: it must be this proposal's currently sent version, valid, with the same hash.
    const [version] = await tx.select().from(proposalVersions).where(and(eq(proposalVersions.id, input.versionId), eq(proposalVersions.proposalId, proposalId))).limit(1);
    if (!version) throw new NotFoundError("Proposal version not found");
    if (version.status !== "sent" || !version.snapshot || !version.contentSha256) throw new ConflictError("Only the currently sent proposal version can be accepted");
    if (!version.validUntil || version.validUntil.getTime() <= Date.now()) throw new ConflictError("This proposal version has expired");
    if (version.contentSha256 !== input.contentSha256) throw new ConflictError("The proposal content has changed; reload it before accepting");
    const snapshot = version.snapshot as VersionSnapshot;
    const option = snapshot.options.find((o) => o.id === input.optionId);
    const [optionRow] = await tx.select({ id: proposalOptions.id }).from(proposalOptions).where(and(eq(proposalOptions.id, input.optionId), eq(proposalOptions.versionId, version.id))).limit(1);
    if (!option || !optionRow) throw new NotFoundError("Proposal option not found");
    const [terms] = await tx.select().from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, version.termsTemplateId!)).limit(1);
    if (!terms || terms.bodySha256 !== snapshot.terms.bodySha256 || terms.version !== snapshot.terms.version || terms.key !== snapshot.terms.key) {
      throw new ConflictError("The proposal terms do not match the sent version");
    }

    // The organization that will hold the contract.
    let organizationId: string;
    if (locked.organizationId) {
      if (input.organization && !("id" in input.organization && input.organization.id === locked.organizationId)) {
        throw new ConflictError("This proposal is addressed to another organization");
      }
      organizationId = locked.organizationId;
      await assertOwnerOfActiveOrganization(actor.userId, organizationId);
    } else if (input.organization && "id" in input.organization) {
      organizationId = input.organization.id;
      await assertOwnerOfActiveOrganization(actor.userId, organizationId);
    } else if (input.organization && "create" in input.organization) {
      organizationId = (await createOrganization({ name: input.organization.create.name, createdBy: actor.userId }, tx)).id;
    } else {
      throw new ConflictError("Choose an organization you own, or create one, to accept this proposal");
    }
    const [organization] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);

    const [acceptance] = await tx
      .insert(proposalAcceptances)
      .values({
        proposalId,
        versionId: version.id,
        optionId: option.id,
        contentSha256: version.contentSha256,
        organizationId,
        acceptedByUserId: actor.userId,
        signerName: input.signerName,
        signerTitle: input.signerTitle ?? null,
        signerEmail: email,
        termsTemplateId: terms.id,
        consentText: consent.consent.text,
        consentSha256: consent.sha256,
        ip: null, // D3: no trustworthy client IP behind the proxy yet — never record a misleading one.
        userAgent: actor.userAgent ? actor.userAgent.slice(0, 500) : null,
        idempotencyKey,
      })
      .returning();
    await tx
      .update(proposals)
      .set({ status: "accepted", acceptedVersionId: version.id, organizationId, updatedAt: sql`now()` })
      .where(eq(proposals.id, proposalId));

    // Contract (pending_activation) — the photograph of what was accepted.
    const [seq] = await tx.execute<{ n: string }>(sql`select nextval('commercial_contract_number_seq')::text as n`);
    const contractNumber = `UL-C-${new Date().getUTCFullYear()}-${String(seq!.n).padStart(6, "0")}`;
    const { parties, snapshot: contractSnapshot } = buildContractVersionSnapshot({
      contractNumber,
      proposal: { id: locked.id, number: locked.number },
      version: { id: version.id, versionNo: version.versionNo, contentSha256: version.contentSha256, hashAlg: version.hashAlg },
      versionSnapshot: snapshot,
      option,
      acceptance: {
        id: acceptance!.id,
        acceptedAt: acceptance!.acceptedAt,
        signerName: acceptance!.signerName,
        signerTitle: acceptance!.signerTitle,
        signerEmail: acceptance!.signerEmail,
        consentKey: consent.consent.key,
        consentVersion: consent.consent.version,
        consentSha256: consent.sha256,
      },
      provider: currentPlatformLegalIdentity(),
      client: { organizationId, organizationName: organization!.name },
      renewalPolicy: "none",
    });
    const contractSha256 = canonicalSha256(contractSnapshot);
    const [contract] = await tx
      .insert(contracts)
      .values({
        number: contractNumber,
        organizationId,
        sourceAcceptanceId: acceptance!.id,
        status: "pending_activation",
        currency: snapshot.version.currency,
        totalMinor: BigInt(option.totalMinor),
        effectiveAt: acceptance!.acceptedAt,
        startsAt: null,
        endsAt: null,
        renewalPolicy: "none",
      })
      .returning();
    const [contractVersion] = await tx
      .insert(contractVersions)
      .values({
        contractId: contract!.id,
        versionNo: 1,
        parties,
        snapshot: contractSnapshot,
        contentSha256: contractSha256,
        termsTemplateId: terms.id,
        termsSha256: snapshot.terms.bodySha256,
        createdBy: actor.userId,
      })
      .returning();
    const [withVersion] = await tx.update(contracts).set({ currentVersionId: contractVersion!.id, updatedAt: sql`now()` }).where(eq(contracts.id, contract!.id)).returning();

    // Items of the CHOSEN option only. Values come from the snapshot; ids from the (immutable since send) proposal rows,
    // matched in canonical order and verified field by field — any divergence aborts everything.
    const rows = await tx
      .select({ item: proposalItems, applicationKey: applications.key, planKey: plans.key })
      .from(proposalItems)
      .leftJoin(applications, eq(applications.id, proposalItems.applicationId))
      .leftJoin(plans, eq(plans.id, proposalItems.planId))
      .where(eq(proposalItems.optionId, option.id))
      .orderBy(asc(proposalItems.sort), asc(proposalItems.createdAt), asc(proposalItems.id));
    if (rows.length !== option.items.length) throw new ConflictError("The accepted option does not match its frozen content");
    for (const [index, snap] of option.items.entries()) {
      const { item, applicationKey, planKey } = rows[index]!;
      const consistent =
        item.kind === snap.kind &&
        item.title === snap.title &&
        item.quantity === snap.quantity &&
        item.unitPriceMinor.toString() === snap.unitPriceMinor &&
        item.lineTotalMinor.toString() === snap.lineTotalMinor &&
        item.billingPeriod === snap.billingPeriod &&
        (item.durationMonths ?? null) === (snap.durationMonths ?? null) &&
        (applicationKey ?? null) === (snap.application?.key ?? null) &&
        (planKey ?? null) === (snap.plan?.key ?? null);
      if (!consistent) throw new ConflictError("The accepted option does not match its frozen content");
      await tx.insert(contractItems).values({
        contractVersionId: contractVersion!.id,
        sourceProposalItemId: item.id,
        sort: snap.position,
        kind: snap.kind,
        title: snap.title,
        description: snap.description ?? null,
        applicationId: item.applicationId,
        planId: item.planId,
        quantity: snap.quantity,
        unitPriceMinor: BigInt(snap.unitPriceMinor),
        lineTotalMinor: BigInt(snap.lineTotalMinor),
        billingPeriod: snap.billingPeriod,
        durationMonths: snap.durationMonths ?? null,
        entitlementSpec: snap.entitlementSpec ?? null,
      });
    }

    const base = { organizationId, actorType: "user" as const, actorUserId: actor.userId, correlationId: actor.requestId };
    await recordCommercialEvent(tx, {
      ...base,
      aggregateType: "proposal_acceptance",
      aggregateId: acceptance!.id,
      eventType: "proposal.accepted",
      idempotencyKey: `proposal.accepted:${proposalId}`,
      payload: { proposalId, versionId: version.id, optionId: option.id, contentSha256: version.contentSha256, consentKey: consent.consent.key, consentVersion: consent.consent.version },
    });
    await recordCommercialEvent(tx, {
      ...base,
      aggregateType: "contract",
      aggregateId: contract!.id,
      eventType: "contract.created",
      idempotencyKey: `contract.created:${acceptance!.id}`,
      payload: { number: contractNumber, acceptanceId: acceptance!.id, status: "pending_activation" },
    });
    await recordCommercialEvent(tx, {
      ...base,
      aggregateType: "contract_version",
      aggregateId: contractVersion!.id,
      eventType: "contract.version.created",
      payload: { contractId: contract!.id, versionNo: 1, contentSha256: contractSha256, termsSha256: snapshot.terms.bodySha256 },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "commercial.proposal.accepted",
        targetType: "proposal_acceptance",
        targetId: acceptance!.id,
        metadata: { proposalNumber: locked.number, contractNumber, versionNo: version.versionNo, contentSha256: version.contentSha256 },
      },
      tx,
    );

    return { created: true, acceptance: acceptanceDto(acceptance!), contract: contractSummaryDto(withVersion!, contractVersion!) };
  });
}
