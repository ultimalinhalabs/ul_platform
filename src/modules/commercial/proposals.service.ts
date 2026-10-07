import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db/index.js";
import {
  applications,
  commercialTermsTemplates,
  organizations,
  plans,
  proposalItems,
  proposalOptions,
  proposals,
  proposalVersions,
} from "../../db/schema/index.js";
import { CommercialRecordImmutableError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { CANONICAL_HASH_ALG, canonicalSha256 } from "./canonicalJson.js";
import { type CommercialActor, recordCommercialEvent } from "./events.js";
import { lineTotalMinor, sumMinor } from "./money.js";
import type {
  createItemSchema,
  createOptionSchema,
  createProposalSchema,
  listProposalsQuerySchema,
  updateItemSchema,
  updateOptionSchema,
  updateProposalSchema,
  updateVersionSchema,
} from "./schemas.js";
import { itemDto, optionDto, proposalDto, versionSummaryDto } from "./serializers.js";

/**
 * Block 1B — proposal domain (platform/console side). Every write runs in one
 * transaction that first locks the proposal row (`FOR UPDATE`), so edits,
 * version creation and sending of the same proposal are serialized. The
 * database triggers of Block 1A remain the final authority (a frozen version
 * cannot change whatever the code does); the service checks first so the API
 * answers with clear 404/409s instead of raw driver errors.
 *
 * Proposal ≠ entitlement: nothing here creates subscriptions, application
 * access, entitlements, contracts, invoices or payments, sends email or calls
 * another service.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;
type ProposalRow = typeof proposals.$inferSelect;
type VersionRow = typeof proposalVersions.$inferSelect;

/** Proposal states in which commercial content can still be (re)sent. */
const SENDABLE_PROPOSAL_STATUSES = new Set(["draft", "sent", "viewed", "negotiation"]);

// ---------------------------------------------------------------------------- helpers

async function assertOrganizationUsable(executor: Executor, organizationId: string) {
  const [org] = await executor.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) throw new NotFoundError("Organization not found");
  if (org.status !== "active") throw new ConflictError("Organization is not active");
}

async function assertTermsTemplateExists(executor: Executor, termsTemplateId: string) {
  const [terms] = await executor.select({ id: commercialTermsTemplates.id }).from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, termsTemplateId)).limit(1);
  if (!terms) throw new NotFoundError("Terms template not found");
}

async function lockProposal(tx: Tx, proposalId: string): Promise<ProposalRow> {
  const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).for("update");
  if (!proposal) throw new NotFoundError("Proposal not found");
  return proposal;
}

async function getVersionOfProposal(executor: Executor, proposalId: string, versionId: string): Promise<VersionRow> {
  const [version] = await executor
    .select()
    .from(proposalVersions)
    .where(and(eq(proposalVersions.id, versionId), eq(proposalVersions.proposalId, proposalId)))
    .limit(1);
  if (!version) throw new NotFoundError("Proposal version not found");
  return version;
}

function assertDraft(version: VersionRow) {
  if (version.status !== "draft" || version.sentAt !== null) {
    throw new CommercialRecordImmutableError("A sent proposal version cannot be changed; create a new version");
  }
}

async function nextProposalNumber(tx: Tx): Promise<string> {
  const [row] = await tx.execute<{ n: string }>(sql`select nextval('commercial_proposal_number_seq')::text as n`);
  return `UL-P-${new Date().getUTCFullYear()}-${String(row!.n).padStart(6, "0")}`;
}

async function getOptionOfVersion(executor: Executor, versionId: string, optionId: string) {
  const [option] = await executor
    .select()
    .from(proposalOptions)
    .where(and(eq(proposalOptions.id, optionId), eq(proposalOptions.versionId, versionId)))
    .limit(1);
  if (!option) throw new NotFoundError("Proposal option not found");
  return option;
}

/** Keeps `proposal_options.total_minor` equal to the sum of its items, in the same transaction as the item change. */
async function recomputeOptionTotal(tx: Tx, optionId: string) {
  const rows = await tx.select({ lineTotalMinor: proposalItems.lineTotalMinor }).from(proposalItems).where(eq(proposalItems.optionId, optionId));
  const total = sumMinor(rows.map((r) => r.lineTotalMinor));
  await tx.update(proposalOptions).set({ totalMinor: total, updatedAt: sql`now()` }).where(eq(proposalOptions.id, optionId));
}

/** At most one recommended option per version: clear the others before marking one. */
async function clearOtherRecommended(tx: Tx, versionId: string) {
  await tx
    .update(proposalOptions)
    .set({ isRecommended: false, updatedAt: sql`now()` })
    .where(and(eq(proposalOptions.versionId, versionId), eq(proposalOptions.isRecommended, true)));
}

/** Resolves application/plan keys to ids and checks their coherence (a plan always belongs to the given application). */
async function resolveItemRefs(executor: Executor, kind: string, applicationKey: string | null | undefined, planKey: string | null | undefined) {
  if (planKey && !applicationKey) throw new ValidationError("planKey requires applicationKey");
  if (kind === "application_plan" && (!applicationKey || !planKey)) throw new ValidationError("An application_plan item requires applicationKey and planKey");
  if (kind !== "application_plan" && planKey) throw new ValidationError("Only application_plan items may reference a plan");
  if (!applicationKey) return { applicationId: null, planId: null };
  const [application] = await executor
    .select({ id: applications.id, status: applications.status })
    .from(applications)
    .where(eq(applications.key, applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${applicationKey}`);
  if (application.status !== "ACTIVE") throw new ConflictError(`Application ${applicationKey} is not active`);
  if (!planKey) return { applicationId: application.id, planId: null };
  const [plan] = await executor
    .select({ id: plans.id, status: plans.status })
    .from(plans)
    .where(and(eq(plans.applicationId, application.id), eq(plans.key, planKey)))
    .limit(1);
  if (!plan) throw new NotFoundError(`Unknown plan ${planKey} for application ${applicationKey}`);
  if (plan.status !== "ACTIVE") throw new ConflictError(`Plan ${planKey} is not active`);
  return { applicationId: application.id, planId: plan.id };
}

async function loadOptionsWithItems(executor: Executor, versionId: string) {
  const options = await executor
    .select()
    .from(proposalOptions)
    .where(eq(proposalOptions.versionId, versionId))
    .orderBy(asc(proposalOptions.sort), asc(proposalOptions.createdAt), asc(proposalOptions.id));
  const optionIds = options.map((o) => o.id);
  const items = optionIds.length
    ? await executor
        .select({
          item: proposalItems,
          applicationKey: applications.key,
          applicationName: applications.name,
          planKey: plans.key,
          planName: plans.name,
        })
        .from(proposalItems)
        .leftJoin(applications, eq(applications.id, proposalItems.applicationId))
        .leftJoin(plans, eq(plans.id, proposalItems.planId))
        .where(inArray(proposalItems.optionId, optionIds))
        .orderBy(asc(proposalItems.sort), asc(proposalItems.createdAt), asc(proposalItems.id))
    : [];
  return options.map((option) => ({ option, items: items.filter((i) => i.item.optionId === option.id) }));
}

// ---------------------------------------------------------------------------- reads

export async function getVersionDetail(proposalId: string, versionId: string, executor: Executor = db) {
  const version = await getVersionOfProposal(executor, proposalId, versionId);
  const options = await loadOptionsWithItems(executor, versionId);
  return {
    ...versionSummaryDto(version),
    options: options.map(({ option, items }) =>
      optionDto(
        option,
        items.map((i) => itemDto(i.item, { applicationKey: i.applicationKey, planKey: i.planKey })),
      ),
    ),
  };
}

export async function getProposalDetail(proposalId: string, executor: Executor = db) {
  const [proposal] = await executor.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) throw new NotFoundError("Proposal not found");
  const versions = await executor.select().from(proposalVersions).where(eq(proposalVersions.proposalId, proposalId)).orderBy(asc(proposalVersions.versionNo));
  return { ...proposalDto(proposal), versions: versions.map(versionSummaryDto) };
}

export async function listProposals(query: z.infer<typeof listProposalsQuerySchema>) {
  const conditions = [];
  if (query.status) conditions.push(eq(proposals.status, query.status));
  if (query.organizationId) conditions.push(eq(proposals.organizationId, query.organizationId));
  const rows = await db
    .select()
    .from(proposals)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(query.limit);
  return rows.map(proposalDto);
}

// ---------------------------------------------------------------------------- proposal

export async function createProposal(input: z.infer<typeof createProposalSchema>, actor: CommercialActor) {
  const proposalId = await db.transaction(async (tx) => {
    if (input.organizationId) await assertOrganizationUsable(tx, input.organizationId);
    if (input.termsTemplateId) await assertTermsTemplateExists(tx, input.termsTemplateId);
    const [proposal] = await tx
      .insert(proposals)
      .values({
        number: await nextProposalNumber(tx),
        prospectCompanyName: input.prospectCompanyName,
        prospectTaxId: input.prospectTaxId ?? null,
        recipientName: input.recipientName,
        recipientEmail: input.recipientEmail,
        organizationId: input.organizationId ?? null,
        ownerUserId: actor.userId,
        createdBy: actor.userId,
      })
      .returning();
    const [version] = await tx
      .insert(proposalVersions)
      .values({
        proposalId: proposal!.id,
        versionNo: 1,
        currency: input.currency,
        validUntil: input.validUntil ?? null,
        summary: input.summary ?? null,
        notes: input.notes ?? null,
        termsTemplateId: input.termsTemplateId ?? null,
        createdBy: actor.userId,
      })
      .returning();
    await tx.update(proposals).set({ currentVersionId: version!.id, updatedAt: sql`now()` }).where(eq(proposals.id, proposal!.id));
    await recordCommercialEvent(tx, {
      aggregateType: "proposal",
      aggregateId: proposal!.id,
      eventType: "proposal.created",
      organizationId: proposal!.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      payload: { number: proposal!.number },
    });
    await recordCommercialEvent(tx, {
      aggregateType: "proposal_version",
      aggregateId: version!.id,
      eventType: "proposal.version.created",
      organizationId: proposal!.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      payload: { proposalId: proposal!.id, versionNo: 1 },
    });
    return proposal!.id;
  });
  return getProposalDetail(proposalId);
}

/** Prospect/recipient details are fixed once a version has been sent (they are part of what the client saw). */
export async function updateProposal(proposalId: string, patch: z.infer<typeof updateProposalSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (proposal.status !== "draft") {
      throw new CommercialRecordImmutableError("Proposal details can only change before the first version is sent");
    }
    if (patch.organizationId) await assertOrganizationUsable(tx, patch.organizationId);
    await tx
      .update(proposals)
      .set({
        ...(patch.prospectCompanyName !== undefined ? { prospectCompanyName: patch.prospectCompanyName } : {}),
        ...(patch.prospectTaxId !== undefined ? { prospectTaxId: patch.prospectTaxId } : {}),
        ...(patch.recipientName !== undefined ? { recipientName: patch.recipientName } : {}),
        ...(patch.recipientEmail !== undefined ? { recipientEmail: patch.recipientEmail } : {}),
        ...(patch.organizationId !== undefined ? { organizationId: patch.organizationId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(proposals.id, proposalId));
  });
  return getProposalDetail(proposalId);
}

// ---------------------------------------------------------------------------- versions

/** A new draft copied from the latest version (options and items included). Only one draft may exist at a time. */
export async function createVersion(proposalId: string, actor: CommercialActor) {
  const versionId = await db.transaction(async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    if (!SENDABLE_PROPOSAL_STATUSES.has(proposal.status)) throw new ConflictError(`A ${proposal.status} proposal cannot get new versions`);
    const [latest] = await tx.select().from(proposalVersions).where(eq(proposalVersions.proposalId, proposalId)).orderBy(desc(proposalVersions.versionNo)).limit(1);
    if (!latest) throw new NotFoundError("Proposal version not found");
    if (latest.status === "draft") throw new ConflictError("A draft version already exists");
    const [version] = await tx
      .insert(proposalVersions)
      .values({
        proposalId,
        versionNo: latest.versionNo + 1,
        currency: latest.currency,
        validUntil: latest.validUntil,
        summary: latest.summary,
        notes: latest.notes,
        termsTemplateId: latest.termsTemplateId,
        createdBy: actor.userId,
      })
      .returning();
    for (const { option, items } of await loadOptionsWithItems(tx, latest.id)) {
      const [copy] = await tx
        .insert(proposalOptions)
        .values({ versionId: version!.id, sort: option.sort, name: option.name, summary: option.summary, isRecommended: option.isRecommended, totalMinor: option.totalMinor })
        .returning();
      for (const { item } of items) {
        await tx.insert(proposalItems).values({
          optionId: copy!.id,
          sort: item.sort,
          kind: item.kind,
          title: item.title,
          description: item.description,
          applicationId: item.applicationId,
          planId: item.planId,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          lineTotalMinor: item.lineTotalMinor,
          billingPeriod: item.billingPeriod,
          durationMonths: item.durationMonths,
          entitlementSpec: item.entitlementSpec,
        });
      }
    }
    await tx.update(proposals).set({ currentVersionId: version!.id, updatedAt: sql`now()` }).where(eq(proposals.id, proposalId));
    await recordCommercialEvent(tx, {
      aggregateType: "proposal_version",
      aggregateId: version!.id,
      eventType: "proposal.version.created",
      organizationId: proposal.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      payload: { proposalId, versionNo: version!.versionNo, copiedFromVersionId: latest.id },
    });
    return version!.id;
  });
  return getVersionDetail(proposalId, versionId);
}

export async function updateVersion(proposalId: string, versionId: string, patch: z.infer<typeof updateVersionSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    if (patch.termsTemplateId) await assertTermsTemplateExists(tx, patch.termsTemplateId);
    await tx
      .update(proposalVersions)
      .set({
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.termsTemplateId !== undefined ? { termsTemplateId: patch.termsTemplateId } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(proposalVersions.id, versionId));
  });
  return getVersionDetail(proposalId, versionId);
}

// ---------------------------------------------------------------------------- options

export async function createOption(proposalId: string, versionId: string, input: z.infer<typeof createOptionSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    if (input.isRecommended) await clearOtherRecommended(tx, versionId);
    await tx.insert(proposalOptions).values({ versionId, name: input.name, summary: input.summary ?? null, isRecommended: input.isRecommended, sort: input.sort, totalMinor: 0n });
  });
  return getVersionDetail(proposalId, versionId);
}

export async function updateOption(proposalId: string, versionId: string, optionId: string, patch: z.infer<typeof updateOptionSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    await getOptionOfVersion(tx, versionId, optionId);
    if (patch.isRecommended === true) await clearOtherRecommended(tx, versionId);
    await tx
      .update(proposalOptions)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.isRecommended !== undefined ? { isRecommended: patch.isRecommended } : {}),
        ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(proposalOptions.id, optionId));
  });
  return getVersionDetail(proposalId, versionId);
}

export async function deleteOption(proposalId: string, versionId: string, optionId: string, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    await getOptionOfVersion(tx, versionId, optionId);
    await tx.delete(proposalOptions).where(eq(proposalOptions.id, optionId)); // items cascade (draft only)
  });
  return getVersionDetail(proposalId, versionId);
}

// ---------------------------------------------------------------------------- items

async function getItemOfOption(executor: Executor, optionId: string, itemId: string) {
  const [row] = await executor
    .select({ item: proposalItems, applicationKey: applications.key, planKey: plans.key })
    .from(proposalItems)
    .leftJoin(applications, eq(applications.id, proposalItems.applicationId))
    .leftJoin(plans, eq(plans.id, proposalItems.planId))
    .where(and(eq(proposalItems.id, itemId), eq(proposalItems.optionId, optionId)))
    .limit(1);
  if (!row) throw new NotFoundError("Proposal item not found");
  return row;
}

export async function createItem(proposalId: string, versionId: string, optionId: string, input: z.infer<typeof createItemSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    await getOptionOfVersion(tx, versionId, optionId);
    const refs = await resolveItemRefs(tx, input.kind, input.applicationKey, input.planKey);
    await tx.insert(proposalItems).values({
      optionId,
      sort: input.sort,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      applicationId: refs.applicationId,
      planId: refs.planId,
      quantity: input.quantity,
      unitPriceMinor: input.unitPriceMinor,
      lineTotalMinor: lineTotalMinor(input.quantity, input.unitPriceMinor),
      billingPeriod: input.billingPeriod,
      durationMonths: input.durationMonths ?? null,
      entitlementSpec: input.entitlementSpec ?? null,
    });
    await recomputeOptionTotal(tx, optionId);
  });
  return getVersionDetail(proposalId, versionId);
}

export async function updateItem(proposalId: string, versionId: string, optionId: string, itemId: string, patch: z.infer<typeof updateItemSchema>, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    await getOptionOfVersion(tx, versionId, optionId);
    const current = await getItemOfOption(tx, optionId, itemId);
    const kind = patch.kind ?? current.item.kind;
    const applicationKey = patch.applicationKey !== undefined ? patch.applicationKey : current.applicationKey;
    const planKey = patch.planKey !== undefined ? patch.planKey : current.planKey;
    const refs = await resolveItemRefs(tx, kind, applicationKey, planKey);
    const quantity = patch.quantity ?? current.item.quantity;
    const unitPriceMinor = patch.unitPriceMinor ?? current.item.unitPriceMinor;
    await tx
      .update(proposalItems)
      .set({
        kind,
        applicationId: refs.applicationId,
        planId: refs.planId,
        quantity,
        unitPriceMinor,
        lineTotalMinor: lineTotalMinor(quantity, unitPriceMinor),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.billingPeriod !== undefined ? { billingPeriod: patch.billingPeriod } : {}),
        ...(patch.durationMonths !== undefined ? { durationMonths: patch.durationMonths } : {}),
        ...(patch.entitlementSpec !== undefined ? { entitlementSpec: patch.entitlementSpec } : {}),
        ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(proposalItems.id, itemId));
    await recomputeOptionTotal(tx, optionId);
  });
  return getVersionDetail(proposalId, versionId);
}

export async function deleteItem(proposalId: string, versionId: string, optionId: string, itemId: string, _actor: CommercialActor) {
  await db.transaction(async (tx) => {
    await lockProposal(tx, proposalId);
    assertDraft(await getVersionOfProposal(tx, proposalId, versionId));
    await getOptionOfVersion(tx, versionId, optionId);
    await getItemOfOption(tx, optionId, itemId);
    await tx.delete(proposalItems).where(eq(proposalItems.id, itemId));
    await recomputeOptionTotal(tx, optionId);
  });
  return getVersionDetail(proposalId, versionId);
}

// ---------------------------------------------------------------------------- send

/** Input of the canonical snapshot: exactly what the client is shown, nothing mutable or internal. */
export interface SnapshotInput {
  proposal: Pick<ProposalRow, "number" | "prospectCompanyName" | "prospectTaxId" | "recipientName" | "recipientEmail">;
  version: Pick<VersionRow, "versionNo" | "currency" | "validUntil" | "summary">;
  terms: { key: string; version: number; title: string; body: string; bodySha256: string };
  options: Awaited<ReturnType<typeof loadOptionsWithItems>>;
}

/**
 * The frozen content of a sent version (schema `ul.commercial.proposal-version/1`).
 * Includes what the client is shown (prospect, recipient, currency, validity,
 * summary, terms, options with their items and totals) and the entitlement
 * spec that later feeds grants. Excludes internal notes, actors, timestamps
 * of the edit process and every database-generated field except the option
 * ids (immutable once sent; acceptance will reference them). Money is
 * serialized as decimal strings; ordering is explicit (sort, created_at, id).
 */
export function buildVersionSnapshot(input: SnapshotInput) {
  return {
    schema: "ul.commercial.proposal-version/1",
    proposal: {
      number: input.proposal.number,
      prospectCompanyName: input.proposal.prospectCompanyName,
      prospectTaxId: input.proposal.prospectTaxId ?? null,
      recipientName: input.proposal.recipientName,
      recipientEmail: input.proposal.recipientEmail,
    },
    version: {
      versionNo: input.version.versionNo,
      currency: input.version.currency,
      validUntil: input.version.validUntil ? input.version.validUntil.toISOString() : null,
      summary: input.version.summary ?? null,
    },
    terms: { ...input.terms },
    options: input.options.map(({ option, items }, position) => ({
      id: option.id,
      position,
      name: option.name,
      summary: option.summary ?? null,
      isRecommended: option.isRecommended,
      totalMinor: option.totalMinor.toString(),
      items: items.map(({ item, applicationKey, applicationName, planKey, planName }, itemPosition) => ({
        position: itemPosition,
        kind: item.kind,
        title: item.title,
        description: item.description ?? null,
        application: applicationKey ? { key: applicationKey, name: applicationName } : null,
        plan: planKey ? { key: planKey, name: planName } : null,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor.toString(),
        lineTotalMinor: item.lineTotalMinor.toString(),
        billingPeriod: item.billingPeriod,
        durationMonths: item.durationMonths ?? null,
        entitlementSpec: item.entitlementSpec ?? null,
      })),
    })),
  };
}

/**
 * Sends (freezes) a draft version: validates content, terms and totals,
 * builds the canonical snapshot and its SHA-256, supersedes the previously
 * sent version and marks the proposal `sent` — all in one transaction.
 * Re-sending an already sent version is idempotent (returns it unchanged).
 */
export async function sendVersion(proposalId: string, versionId: string, actor: CommercialActor) {
  await db.transaction(async (tx) => {
    const proposal = await lockProposal(tx, proposalId);
    const version = await getVersionOfProposal(tx, proposalId, versionId);
    if (version.status === "sent") return; // idempotent repeat
    assertDraft(version);
    if (!SENDABLE_PROPOSAL_STATUSES.has(proposal.status)) throw new ConflictError(`A ${proposal.status} proposal cannot be sent`);
    if (proposal.organizationId) await assertOrganizationUsable(tx, proposal.organizationId);

    const options = await loadOptionsWithItems(tx, versionId);
    if (options.length === 0) throw new ConflictError("A proposal version needs at least one option to be sent");
    if (options.some((o) => o.items.length === 0)) throw new ConflictError("Every option needs at least one item to be sent");
    const recommended = options.filter((o) => o.option.isRecommended).length;
    if (options.length >= 2 && recommended !== 1) throw new ConflictError("Exactly one option must be recommended when there are two or more options");
    for (const { option, items } of options) {
      for (const { item } of items) {
        if (item.lineTotalMinor !== lineTotalMinor(item.quantity, item.unitPriceMinor)) throw new ConflictError("An item total is inconsistent");
      }
      if (option.totalMinor !== sumMinor(items.map((i) => i.item.lineTotalMinor))) throw new ConflictError(`The total of option "${option.name}" is inconsistent`);
    }

    if (!version.termsTemplateId) throw new ConflictError("Approved terms are required to send a proposal");
    const [terms] = await tx.select().from(commercialTermsTemplates).where(eq(commercialTermsTemplates.id, version.termsTemplateId)).limit(1);
    if (!terms || terms.status !== "approved") throw new ConflictError("Approved terms are required to send a proposal");
    if (!version.validUntil || version.validUntil.getTime() <= Date.now()) throw new ConflictError("valid_until must be set in the future to send a proposal");

    const snapshot = buildVersionSnapshot({
      proposal,
      version,
      terms: { key: terms.key, version: terms.version, title: terms.title, body: terms.body, bodySha256: terms.bodySha256 },
      options,
    });
    const contentSha256 = canonicalSha256(snapshot);

    const superseded = await tx
      .update(proposalVersions)
      .set({ status: "superseded", updatedAt: sql`now()` })
      .where(and(eq(proposalVersions.proposalId, proposalId), eq(proposalVersions.status, "sent")))
      .returning({ id: proposalVersions.id });
    await tx
      .update(proposalVersions)
      .set({ status: "sent", sentAt: sql`now()`, sentBy: actor.userId, snapshot, contentSha256, hashAlg: CANONICAL_HASH_ALG, updatedAt: sql`now()` })
      .where(eq(proposalVersions.id, versionId));
    await tx.update(proposals).set({ status: "sent", currentVersionId: versionId, updatedAt: sql`now()` }).where(eq(proposals.id, proposalId));

    await recordCommercialEvent(tx, {
      aggregateType: "proposal_version",
      aggregateId: versionId,
      eventType: "proposal.version.sent",
      organizationId: proposal.organizationId,
      actorType: "platform_admin",
      actorUserId: actor.userId,
      correlationId: actor.requestId,
      idempotencyKey: `proposal.version.sent:${versionId}`,
      payload: { proposalId, versionNo: version.versionNo, contentSha256, hashAlg: CANONICAL_HASH_ALG, supersededVersionIds: superseded.map((s) => s.id) },
    });
    await recordAuditEvent(
      {
        actorUserId: actor.userId,
        organizationId: proposal.organizationId ?? undefined,
        action: "platform.commercial.proposal.sent",
        targetType: "proposal_version",
        targetId: versionId,
        metadata: { proposalNumber: proposal.number, versionNo: version.versionNo, contentSha256 },
      },
      tx,
    );
  });
  return getVersionDetail(proposalId, versionId);
}
