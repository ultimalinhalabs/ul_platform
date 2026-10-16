import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { memberships, organizationCreationRequests, organizations } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getRoleByKey } from "../roles/service.js";
import { ConflictError, NotFoundError, OrganizationCreationLimitError, OrganizationSuspendedError } from "../../shared/errors.js";

/** The random slug suffix. Replaceable only by tests, to force a collision (tests/organization-creation.test.ts). */
export const slugSuffix = { next: (): string => randomBytes(3).toString("hex") };

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "org"}-${slugSuffix.next()}`;
}

/**
 * Creating an organization is a platform-level action, not an org-scoped
 * one — there's no membership to check permissions against before the
 * organization exists. Any user with a verified email may create one
 * (checked by the callers: the route, and proposal acceptance); they become
 * the new organization's OWNER atomically with its creation.
 */
export async function createOrganization(
  input: { name: string; slug?: string; createdBy: string },
  /** Block 1C — run inside the caller's transaction (proposal acceptance); omitted, it opens its own exactly as before. */
  executor?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<typeof organizations.$inferSelect> {
  if (!executor) return db.transaction((tx) => createOrganization(input, tx));
  const tx = executor;
  const ownerRole = await getRoleByKey("OWNER", tx);

  // A generated slug that happens to be taken is retried with a new suffix; a slug the caller
  // chose is theirs to change (409). ON CONFLICT DO NOTHING keeps the caller's transaction usable.
  let organization: typeof organizations.$inferSelect | undefined;
  for (let attempt = 0; !organization && attempt < SLUG_ATTEMPTS; attempt++) {
    [organization] = await tx
      .insert(organizations)
      .values({
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        createdBy: input.createdBy,
      })
      .onConflictDoNothing({ target: organizations.slug })
      .returning();
    if (!organization && input.slug) throw new ConflictError("This organization slug is already in use");
  }
  if (!organization) throw new Error("Failed to create organization: no free slug");

  await tx.insert(memberships).values({
    userId: input.createdBy,
    organizationId: organization.id,
    roleId: ownerRole.id,
    status: "active",
  });

  await recordAuditEvent(
    {
      actorUserId: input.createdBy,
      organizationId: organization.id,
      action: "organization.created",
      targetType: "organization",
      targetId: organization.id,
    },
    tx,
  );

  return organization;
}

const SLUG_ATTEMPTS = 5;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The single per-user creation guard, shared by every path that creates an
 * organization for a user (`POST /v1/organizations` and proposal acceptance
 * with `organization.create`): takes a transaction-scoped advisory lock on
 * the user — concurrent creations by one user are serialized, so neither a
 * double submission nor parallel requests can slip past the window — and
 * refuses with 429 ORGANIZATION_CREATION_LIMIT when the user already created
 * `ORGANIZATION_CREATION_DAILY_LIMIT` organizations in the last 24 hours
 * (rolling, counted from `organizations.created_by` in the database, so the
 * limit holds across server instances; `0` disables it).
 */
export async function lockAndAssertCreationWindow(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`organization.create:${userId}`}, 0))`);
  const limit = env.ORGANIZATION_CREATION_DAILY_LIMIT;
  if (limit <= 0) return;
  const [recent] = await tx
    .select({ n: count() })
    .from(organizations)
    .where(and(eq(organizations.createdBy, userId), gt(organizations.createdAt, sql`now() - interval '24 hours'`)));
  if ((recent?.n ?? 0) >= limit) throw new OrganizationCreationLimitError();
}

/** The canonical request body an Idempotency-Key is bound to. */
function creationRequestSha256(input: { name: string; slug?: string }): string {
  return createHash("sha256").update(JSON.stringify({ name: input.name, slug: input.slug ?? null })).digest("hex");
}

/**
 * `POST /v1/organizations` — creates the organization and its OWNER
 * membership (createOrganization, one transaction) exactly once per
 * Idempotency-Key:
 *  - same key, same body ⇒ the organization it already created (`replayed`);
 *  - same key, different body ⇒ 409, never a second tenant or an overwrite;
 *  - over the per-user 24-hour window ⇒ 429 (lockAndAssertCreationWindow).
 * The key lookup runs under the per-user lock, so a replay is answered even
 * when the window is full, and concurrent submissions create exactly one row.
 *
 * Creating an organization grants no application access, subscription or
 * contract — those come only from Última Linha (commercial activation).
 * The caller's verified email is checked by the route, before this runs.
 */
export async function createOrganizationIdempotently(input: {
  name: string;
  slug?: string;
  createdBy: string;
  idempotencyKey: string;
}): Promise<{ organization: typeof organizations.$inferSelect; replayed: boolean }> {
  const requestSha256 = creationRequestSha256(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`organization.create:${input.createdBy}`}, 0))`);
    const [previous] = await tx
      .select()
      .from(organizationCreationRequests)
      .where(and(eq(organizationCreationRequests.userId, input.createdBy), eq(organizationCreationRequests.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (previous) {
      if (previous.requestSha256 !== requestSha256) {
        throw new ConflictError("This Idempotency-Key was already used for a different organization");
      }
      // The replay answers only while the caller still belongs to what it created.
      const [replayed] = await tx
        .select({ organization: organizations })
        .from(organizations)
        .innerJoin(memberships, and(eq(memberships.organizationId, organizations.id), eq(memberships.userId, input.createdBy), eq(memberships.status, "active")))
        .where(eq(organizations.id, previous.organizationId))
        .limit(1);
      if (!replayed) throw new ConflictError("This Idempotency-Key was already used");
      return { organization: replayed.organization, replayed: true };
    }

    await lockAndAssertCreationWindow(tx, input.createdBy); // same lock again (re-entrant within the transaction)
    const organization = await createOrganization({ name: input.name, slug: input.slug, createdBy: input.createdBy }, tx);
    await tx.insert(organizationCreationRequests).values({
      userId: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      requestSha256,
      organizationId: organization.id,
    });
    return { organization, replayed: false };
  });
}

/**
 * Fase 6 — the single rule for "may this organization operate": a
 * `suspended` organization blocks every membership-scoped route and every
 * organization-scoped service credential.
 */
export function assertOrganizationActive(status: "active" | "suspended" | null | undefined): void {
  if (status === "suspended") throw new OrganizationSuspendedError();
}

export async function getOrganizationStatus(organizationId: string): Promise<"active" | "suspended" | null> {
  const [row] = await db
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.status ?? null;
}

/** Fase 6 — platform-admin operation: suspend or reactivate an organization (audited). */
export async function setOrganizationStatus(input: {
  organizationId: string;
  status: "active" | "suspended";
  actorUserId: string;
}) {
  const [current] = await db
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!current) throw new NotFoundError("Organization not found");
  const [updated] = await db
    .update(organizations)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(organizations.id, input.organizationId))
    .returning({ id: organizations.id, status: organizations.status });
  await recordAuditEvent({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId,
    action: input.status === "suspended" ? "organization.suspended" : "organization.reactivated",
    targetType: "organization",
    targetId: input.organizationId,
    metadata: { previousStatus: current.status, status: input.status },
  });
  return updated!;
}

export async function getOrganizationById(organizationId: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) throw new NotFoundError("Organization not found");
  return organization;
}

export async function updateOrganization(
  organizationId: string,
  patch: { name?: string; slug?: string },
  actorUserId: string,
) {
  const [organization] = await db
    .update(organizations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!organization) throw new NotFoundError("Organization not found");

  await recordAuditEvent({
    actorUserId,
    organizationId,
    action: "organization.updated",
    targetType: "organization",
    targetId: organizationId,
    metadata: patch,
  });

  return organization;
}

export async function deleteOrganization(organizationId: string, actorUserId: string) {
  const [organization] = await db
    .delete(organizations)
    .where(eq(organizations.id, organizationId))
    .returning();
  if (!organization) throw new NotFoundError("Organization not found");

  await recordAuditEvent({
    actorUserId,
    action: "organization.deleted",
    targetType: "organization",
    targetId: organizationId,
    metadata: { name: organization.name, slug: organization.slug },
  });
}
