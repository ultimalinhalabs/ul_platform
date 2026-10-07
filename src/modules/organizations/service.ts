import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { memberships, organizations } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getRoleByKey } from "../roles/service.js";
import { NotFoundError, OrganizationSuspendedError } from "../../shared/errors.js";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

/**
 * Creating an organization is a platform-level action, not an org-scoped
 * one — there's no membership to check permissions against before the
 * organization exists. Any authenticated user may call this; they become
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

  const [organization] = await tx
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      createdBy: input.createdBy,
    })
    .returning();
  if (!organization) throw new Error("Failed to create organization");

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
