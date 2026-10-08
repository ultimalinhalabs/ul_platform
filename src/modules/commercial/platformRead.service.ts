import { and, count, desc, eq, exists, gte, ilike, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { db } from "../../db/index.js";
import {
  apiKeys,
  applications,
  commercialEvents,
  commercialTermsTemplates,
  contractItems,
  contracts,
  contractVersions,
  credentialProvisioningRequests,
  entitlementGrants,
  memberships,
  organizationApplicationAccess,
  organizations,
  plans,
  proposalAcceptances,
  proposals,
  proposalVersions,
  roles,
  subscriptions,
  users,
} from "../../db/schema/index.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import { ACCESS_NOT_EXPIRED_BY_GRANT, SUBSCRIPTION_EFFECTIVE } from "../entitlements/effectiveness.js";
import type {
  listCommercialEventsQuerySchema,
  listContractsQuerySchema,
  listOrganizationsQuerySchema,
  listProvisioningsQuerySchema,
} from "./platformRead.schemas.js";
import { contractSummaryDto } from "./serializers.js";

/**
 * UL Console MVP — platform-plane READ model of the commercial domain (organizations, members, terms,
 * contracts, provisioning, commercial events, summary). Gated by `platform.commercial.read` in the
 * routes. Read-only by construction: no function here writes. Every response is an explicit field list
 * — never a credential secret or hash, a token, a terms body or an encryption artefact. Keyset
 * pagination on (createdAt, id) descending, like the platform audit log.
 */

/**
 * Keyset cursor = (timestamp, id). The timestamp is carried at FULL Postgres precision (microseconds,
 * rendered by Postgres via `preciseAt`) and compared in SQL — never through a JS Date, which only holds
 * milliseconds: two rows in the same millisecond would otherwise make the next page skip one.
 * Older millisecond cursors (`…sss.mmmZ`) are still accepted.
 */
type Cursor = { at: string; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** A column's value as a UTC ISO string with microseconds, produced by Postgres. */
const preciseAt = (column: SQL.Aliased | PgColumn) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** "Strictly after the cursor" for ORDER BY (column DESC, id DESC), compared at full precision. */
const afterCursor = (column: PgColumn, idColumn: PgColumn, c: Cursor) =>
  or(sql`${column} < ${c.at}::timestamptz`, and(sql`${column} = ${c.at}::timestamptz`, lt(idColumn, c.id)))!;

function encodeCursor(at: string, id: string) {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(raw: string): Cursor {
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!at || !ISO_UTC.test(at) || Number.isNaN(new Date(at).getTime()) || !id || !UUID.test(id)) throw new ValidationError("Invalid cursor");
  return { at, id };
}
function page<T extends { cursorAt: string }>(rows: T[], limit: number, idOf: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.cursorAt, idOf(last)) : null };
}
/** Removes the internal cursor column before a row leaves the module. */
function withoutCursor<T extends { cursorAt: string }>(row: T): Omit<T, "cursorAt"> {
  const { cursorAt, ...rest } = row;
  void cursorAt;
  return rest;
}
/**
 * Runs the given (lazy) Drizzle queries ONE AT A TIME and returns their results in order — same shape as
 * Promise.all. Never Promise.all database reads here: production reaches Postgres through the Supabase
 * transaction pooler with a small client pool (max 5, db/index.ts), and several queries in flight at once
 * through that pooler can stall (GET /platform/commercial/summary hit the 300 s Vercel timeout with 8
 * parallel counts; reproduced locally with Supavisor in transaction mode: old code hung, this returns).
 */
async function inSequence<T extends readonly unknown[]>(queries: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }]): Promise<T> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as unknown as T;
}

/** Literal match: `%`, `_` and `\` in user input are escaped, never wildcards. */
const likeLiteral = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const SENSITIVE_KEY = /(token|secret|password|passphrase|private_?key|credential_?value)/i;
/** Defense in depth for event payloads (none of today's events carries such a key). */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v)]));
  }
  return value;
}

// ------------------------------------------------------------------------------------ organizations

export async function listPlatformOrganizations(q: z.infer<typeof listOrganizationsQuerySchema>) {
  const conditions: SQL[] = [];
  if (q.status) conditions.push(eq(organizations.status, q.status));
  if (q.search) conditions.push(or(ilike(organizations.name, likeLiteral(q.search)), ilike(organizations.slug, likeLiteral(q.search)))!);
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conditions.push(afterCursor(organizations.createdAt, organizations.id, c));
  }
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, status: organizations.status, createdAt: organizations.createdAt, cursorAt: preciseAt(organizations.createdAt) })
    .from(organizations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(organizations.createdAt), desc(organizations.id))
    .limit(q.limit + 1);
  const result = page(rows, q.limit, (r) => r.id);
  const ids = result.items.map((r) => r.id);
  const [access, contractCounts] = ids.length
    ? await inSequence([
        db
          .select({ organizationId: organizationApplicationAccess.organizationId, applicationKey: applications.key })
          .from(organizationApplicationAccess)
          .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
          .where(and(inArray(organizationApplicationAccess.organizationId, ids), eq(organizationApplicationAccess.status, "active"), ACCESS_NOT_EXPIRED_BY_GRANT)),
        db
          .select({ organizationId: contracts.organizationId, status: contracts.status, n: count() })
          .from(contracts)
          .where(inArray(contracts.organizationId, ids))
          .groupBy(contracts.organizationId, contracts.status),
      ])
    : [[], []];
  return {
    items: result.items.map(withoutCursor).map((o) => ({
      ...o,
      applications: access.filter((a) => a.organizationId === o.id).map((a) => a.applicationKey).sort(),
      contracts: Object.fromEntries(contractCounts.filter((c) => c.organizationId === o.id).map((c) => [c.status, c.n])),
    })),
    nextCursor: result.nextCursor,
  };
}

async function requireOrganization(organizationId: string) {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, status: organizations.status, createdAt: organizations.createdAt, updatedAt: organizations.updatedAt })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!org) throw new NotFoundError("Organization not found");
  return org;
}

function provisioningSelection() {
  return {
    id: credentialProvisioningRequests.id,
    organizationId: credentialProvisioningRequests.organizationId,
    application: applications.key,
    purpose: credentialProvisioningRequests.purpose,
    kind: credentialProvisioningRequests.kind,
    status: credentialProvisioningRequests.status,
    issueCount: credentialProvisioningRequests.issueCount,
    requestedBy: credentialProvisioningRequests.requestedBy,
    predecessorId: credentialProvisioningRequests.predecessorId,
    contractId: credentialProvisioningRequests.contractId,
    createdAt: credentialProvisioningRequests.createdAt,
    updatedAt: credentialProvisioningRequests.updatedAt,
    // The managed credential's PUBLIC identifier and lifecycle only — never its hash or secret.
    credentialId: apiKeys.id,
    credentialStatus: apiKeys.status,
    credentialCreatedAt: apiKeys.createdAt,
    credentialRevokedAt: apiKeys.revokedAt,
    cursorAt: preciseAt(credentialProvisioningRequests.createdAt), // internal — stripped by provisioningDto
  };
}
type ProvisioningRow = Awaited<ReturnType<typeof provisioningRows>>[number];
function provisioningRows(where: SQL | undefined, limit?: number) {
  const query = db
    .select(provisioningSelection())
    .from(credentialProvisioningRequests)
    .innerJoin(applications, eq(applications.id, credentialProvisioningRequests.applicationId))
    .leftJoin(apiKeys, eq(apiKeys.id, credentialProvisioningRequests.currentCredentialId))
    .where(where)
    .orderBy(desc(credentialProvisioningRequests.createdAt), desc(credentialProvisioningRequests.id));
  return limit ? query.limit(limit) : query;
}
function provisioningDto(r: ProvisioningRow) {
  const { credentialId, credentialStatus, credentialCreatedAt, credentialRevokedAt, ...rest } = withoutCursor(r);
  return { ...rest, credential: credentialId ? { id: credentialId, status: credentialStatus, createdAt: credentialCreatedAt, revokedAt: credentialRevokedAt } : null };
}

export async function getPlatformOrganization(organizationId: string) {
  const organization = await requireOrganization(organizationId);
  const [access, subs, contractRows, provisioning] = await inSequence([
    db
      .select({
        applicationKey: applications.key,
        applicationName: applications.name,
        status: organizationApplicationAccess.status,
        effective: sql<boolean>`(${organizationApplicationAccess.status} = 'active' and ${ACCESS_NOT_EXPIRED_BY_GRANT})`,
        grantedAt: organizationApplicationAccess.createdAt,
        revokedAt: organizationApplicationAccess.revokedAt,
      })
      .from(organizationApplicationAccess)
      .innerJoin(applications, eq(applications.id, organizationApplicationAccess.applicationId))
      .where(eq(organizationApplicationAccess.organizationId, organizationId))
      .orderBy(applications.key),
    db
      .select({
        id: subscriptions.id,
        applicationKey: applications.key,
        planKey: plans.key,
        status: subscriptions.status,
        effective: sql<boolean>`${SUBSCRIPTION_EFFECTIVE}`,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        canceledAt: subscriptions.canceledAt,
        createdAt: subscriptions.createdAt,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(applications, eq(applications.id, plans.applicationId))
      .where(eq(subscriptions.organizationId, organizationId))
      .orderBy(desc(subscriptions.createdAt)),
    db
      .select({ contract: contracts, version: contractVersions })
      .from(contracts)
      .leftJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
      .where(eq(contracts.organizationId, organizationId))
      .orderBy(desc(contracts.createdAt), desc(contracts.id)),
    provisioningRows(eq(credentialProvisioningRequests.organizationId, organizationId)),
  ]);
  return {
    organization,
    applications: access,
    subscriptions: subs,
    contracts: contractRows.map((r) => contractSummaryDto(r.contract, r.version)),
    provisioning: provisioning.map(provisioningDto),
  };
}

/** Members, minimal: what commercial operations need (who can accept as OWNER). No auth/session data. */
export async function listPlatformOrganizationMembers(organizationId: string) {
  await requireOrganization(organizationId);
  return db
    .select({ membershipId: memberships.id, email: users.email, role: roles.key, status: memberships.status, createdAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(memberships.createdAt, memberships.id);
}

// ------------------------------------------------------------------------------------------ terms

/** Read-only, as stored. The body (legal text) is not returned; its hash identifies it. No approval here. */
export async function listPlatformTerms() {
  return db
    .select({
      id: commercialTermsTemplates.id,
      key: commercialTermsTemplates.key,
      version: commercialTermsTemplates.version,
      title: commercialTermsTemplates.title,
      status: commercialTermsTemplates.status,
      contentSha256: commercialTermsTemplates.bodySha256,
      createdAt: commercialTermsTemplates.createdAt,
      updatedAt: commercialTermsTemplates.updatedAt,
      approvedAt: commercialTermsTemplates.approvedAt,
      approvedBy: commercialTermsTemplates.approvedBy,
    })
    .from(commercialTermsTemplates)
    .orderBy(commercialTermsTemplates.key, desc(commercialTermsTemplates.version));
}

// -------------------------------------------------------------------------------------- contracts

export async function listPlatformContracts(q: z.infer<typeof listContractsQuerySchema>) {
  const conditions: SQL[] = [];
  if (q.organizationId) conditions.push(eq(contracts.organizationId, q.organizationId));
  if (q.status) conditions.push(eq(contracts.status, q.status));
  if (q.applicationKey) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(contractItems)
          .innerJoin(applications, eq(applications.id, contractItems.applicationId))
          .where(and(eq(contractItems.contractVersionId, contracts.currentVersionId), eq(applications.key, q.applicationKey))),
      ),
    );
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conditions.push(afterCursor(contracts.createdAt, contracts.id, c));
  }
  const rows = await db
    .select({ contract: contracts, version: contractVersions, organizationName: organizations.name, cursorAt: preciseAt(contracts.createdAt) })
    .from(contracts)
    .innerJoin(organizations, eq(organizations.id, contracts.organizationId))
    .leftJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(contracts.createdAt), desc(contracts.id))
    .limit(q.limit + 1);
  const result = page(rows, q.limit, (r) => r.contract.id);
  const versionIds = result.items.map((r) => r.version?.id).filter((v): v is string => Boolean(v));
  const apps = versionIds.length
    ? await db
        .selectDistinct({ versionId: contractItems.contractVersionId, key: applications.key })
        .from(contractItems)
        .innerJoin(applications, eq(applications.id, contractItems.applicationId))
        .where(inArray(contractItems.contractVersionId, versionIds))
    : [];
  return {
    items: result.items.map((r) => ({
      ...contractSummaryDto(r.contract, r.version),
      organizationName: r.organizationName,
      applications: apps.filter((a) => a.versionId === r.version?.id).map((a) => a.key).sort(),
    })),
    nextCursor: result.nextCursor,
  };
}

// ---------------------------------------------------------------------------------- provisioning

export async function listPlatformProvisionings(q: z.infer<typeof listProvisioningsQuerySchema>) {
  const conditions: SQL[] = [];
  if (q.organizationId) conditions.push(eq(credentialProvisioningRequests.organizationId, q.organizationId));
  if (q.status) conditions.push(eq(credentialProvisioningRequests.status, q.status));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conditions.push(afterCursor(credentialProvisioningRequests.createdAt, credentialProvisioningRequests.id, c));
  }
  const rows = await provisioningRows(conditions.length ? and(...conditions) : undefined, q.limit + 1);
  const result = page(rows, q.limit, (r) => r.id);
  const names = result.items.length
    ? await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, [...new Set(result.items.map((r) => r.organizationId))]))
    : [];
  return {
    items: result.items.map((r) => ({ ...provisioningDto(r), organizationName: names.find((n) => n.id === r.organizationId)?.name ?? null })),
    nextCursor: result.nextCursor,
  };
}

// ---------------------------------------------------------------------------------------- events

export async function listPlatformCommercialEvents(q: z.infer<typeof listCommercialEventsQuerySchema>) {
  if (q.from && q.to && q.from > q.to) throw new ValidationError("from must not be after to");
  const conditions: SQL[] = [];
  if (q.organizationId) conditions.push(eq(commercialEvents.organizationId, q.organizationId));
  if (q.eventType) conditions.push(eq(commercialEvents.eventType, q.eventType));
  if (q.aggregateType) conditions.push(eq(commercialEvents.aggregateType, q.aggregateType));
  if (q.from) conditions.push(gte(commercialEvents.occurredAt, q.from));
  if (q.to) conditions.push(lte(commercialEvents.occurredAt, q.to));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conditions.push(afterCursor(commercialEvents.occurredAt, commercialEvents.id, c));
  }
  const rows = await db
    .select({
      id: commercialEvents.id,
      eventType: commercialEvents.eventType,
      aggregateType: commercialEvents.aggregateType,
      aggregateId: commercialEvents.aggregateId,
      organizationId: commercialEvents.organizationId,
      organizationName: organizations.name,
      actorType: commercialEvents.actorType,
      actorUserId: commercialEvents.actorUserId,
      actorEmail: users.email,
      correlationId: commercialEvents.correlationId,
      payload: commercialEvents.payload,
      occurredAt: commercialEvents.occurredAt,
      cursorAt: preciseAt(commercialEvents.occurredAt),
    })
    .from(commercialEvents)
    .leftJoin(organizations, eq(organizations.id, commercialEvents.organizationId))
    .leftJoin(users, eq(users.id, commercialEvents.actorUserId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(commercialEvents.occurredAt), desc(commercialEvents.id))
    .limit(q.limit + 1);
  const result = page(rows, q.limit, (r) => r.id);
  return { items: result.items.map(withoutCursor).map((r) => ({ ...r, payload: redact(r.payload) })), nextCursor: result.nextCursor };
}

// --------------------------------------------------------------------------------------- summary

/** Simple operational counts straight from the model (no analytics, no materialized views). */
export async function getPlatformCommercialSummary() {
  const [orgs, proposalRows, contractRows, provisioningRowsByStatus, credentialRows, [activeSubs], [effectiveAccess], [activeGrants]] = await inSequence([
    db.select({ status: organizations.status, n: count() }).from(organizations).groupBy(organizations.status),
    db.select({ status: proposals.status, n: count() }).from(proposals).groupBy(proposals.status),
    db.select({ status: contracts.status, n: count() }).from(contracts).groupBy(contracts.status),
    db.select({ status: credentialProvisioningRequests.status, n: count() }).from(credentialProvisioningRequests).groupBy(credentialProvisioningRequests.status),
    db.select({ status: apiKeys.status, n: count() }).from(apiKeys).where(eq(apiKeys.credentialClass, "INTEGRATION_MANAGED")).groupBy(apiKeys.status),
    db.select({ n: count() }).from(subscriptions).where(SUBSCRIPTION_EFFECTIVE),
    db.select({ n: count() }).from(organizationApplicationAccess).where(and(eq(organizationApplicationAccess.status, "active"), ACCESS_NOT_EXPIRED_BY_GRANT)),
    db.select({ n: count() }).from(entitlementGrants).where(and(eq(entitlementGrants.status, "active"), or(sql`${entitlementGrants.endsAt} is null`, sql`${entitlementGrants.endsAt} > now()`))),
  ]);
  const toMap = (rows: Array<{ status: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const total = (rows: Array<{ n: number }>) => rows.reduce((s, r) => s + r.n, 0);
  return {
    organizations: { total: total(orgs), byStatus: toMap(orgs) },
    proposals: { total: total(proposalRows), byStatus: toMap(proposalRows) },
    contracts: { total: total(contractRows), byStatus: toMap(contractRows) },
    effectiveSubscriptions: activeSubs!.n,
    effectiveApplicationAccess: effectiveAccess!.n,
    effectiveGrants: activeGrants!.n,
    provisioningRequests: { total: total(provisioningRowsByStatus), byStatus: toMap(provisioningRowsByStatus) },
    managedCredentials: { total: total(credentialRows), byStatus: toMap(credentialRows) },
  };
}

// ---------------------------------------------------------------------------------- contract source

/**
 * Additive context for `GET /platform/contracts/:id`: which proposal/version/option the contract came
 * from (via its source acceptance). Read-only; no hash, consent text or user agent is returned.
 */
export async function getContractSource(contractId: string) {
  const [row] = await db
    .select({
      proposalId: proposalAcceptances.proposalId,
      proposalNumber: proposals.number,
      versionId: proposalAcceptances.versionId,
      versionNo: proposalVersions.versionNo,
      optionId: proposalAcceptances.optionId,
      acceptedAt: proposalAcceptances.acceptedAt,
      signerName: proposalAcceptances.signerName,
      termsTemplateId: proposalAcceptances.termsTemplateId,
    })
    .from(contracts)
    .innerJoin(proposalAcceptances, eq(proposalAcceptances.id, contracts.sourceAcceptanceId))
    .innerJoin(proposals, eq(proposals.id, proposalAcceptances.proposalId))
    .innerJoin(proposalVersions, eq(proposalVersions.id, proposalAcceptances.versionId))
    .where(eq(contracts.id, contractId))
    .limit(1);
  return row ?? null;
}
