import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { memberships, organizations } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { getRoleByKey } from "../roles/service.js";
import { NotFoundError } from "../../shared/errors.js";

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
export async function createOrganization(input: { name: string; slug?: string; createdBy: string }) {
  return db.transaction(async (tx) => {
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
  });
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
