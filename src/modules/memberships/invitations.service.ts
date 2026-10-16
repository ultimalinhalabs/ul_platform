import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { memberships, organizationInvitations, organizations, roles, users } from "../../db/schema/index.js";
import { AppError, ConflictError, EmailNotVerifiedError, NotFoundError, OrganizationSuspendedError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import { assertOwnerRoleChangeAllowed } from "../authorization/service.js";
import { getRoleByKey } from "../roles/service.js";
import { isEmailVerified } from "../users/service.js";
import { assertMemberCapacityInTx } from "./memberLimit.js";

/**
 * Migration 0025 — team invitations by email (organizationInvitations.ts).
 * The inviter never learns whether the email has an account (no enumeration);
 * the invitee accepts signed in with that VERIFIED email; acceptance creates
 * an `active` membership with the invited role in one transaction. Pending
 * invitations take a place under `members.max`. UL Platform sends no email.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InvitationRow = typeof organizationInvitations.$inferSelect;

export const createInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    roleKey: z.string().min(1).max(50),
  })
  .strict();

export class AlreadyMemberError extends AppError {
  constructor() {
    super(409, "ALREADY_MEMBER", "This person is already a member of the organization");
  }
}
export class InvitationPendingError extends AppError {
  constructor() {
    super(409, "INVITATION_PENDING", "There is already a pending invitation for this email");
  }
}

/** A pending invitation past its expiry is `expired` for every reader, even before it is persisted as such. */
function effectiveStatus(row: InvitationRow): InvitationRow["status"] {
  return row.status === "pending" && row.expiresAt.getTime() <= Date.now() ? "expired" : row.status;
}

function invitationDto(row: InvitationRow & { roleKey: string }) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    roleKey: row.roleKey,
    status: effectiveStatus(row),
    invitedByUserId: row.invitedByUserId,
    expiresAt: row.expiresAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Persist expiry of stale pending invitations of one organization (keeps the one-pending index free for a re-invite). */
async function expireStaleInTx(tx: Tx, organizationId: string) {
  await tx
    .update(organizationInvitations)
    .set({ status: "expired", updatedAt: sql`now()` })
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, "pending"), lte(organizationInvitations.expiresAt, sql`now()`)));
}

export async function createInvitation(input: { organizationId: string; email: string; roleKey: string; actorUserId: string; actorRoleKey: string }) {
  assertOwnerRoleChangeAllowed(input.actorRoleKey, [input.roleKey]);
  const role = await getRoleByKey(input.roleKey);
  const email = input.email.trim().toLowerCase();

  const row = await db.transaction(async (tx) => {
    // Same per-organization lock as every other place-taking operation (memberLimit.ts).
    await assertMemberCapacityInTx(tx, input.organizationId);
    await expireStaleInTx(tx, input.organizationId);
    const [member] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, input.organizationId), sql`lower(${users.email}) = ${email}`))
      .limit(1);
    if (member) throw new AlreadyMemberError();
    const [pending] = await tx
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(and(eq(organizationInvitations.organizationId, input.organizationId), eq(organizationInvitations.email, email), eq(organizationInvitations.status, "pending")))
      .limit(1);
    if (pending) throw new InvitationPendingError();
    const [created] = await tx
      .insert(organizationInvitations)
      .values({
        organizationId: input.organizationId,
        email,
        roleId: role.id,
        invitedByUserId: input.actorUserId,
        expiresAt: sql`now() + make_interval(days => ${env.INVITATION_VALIDITY_DAYS}::int)` as unknown as Date,
      })
      .returning();
    // No email address in the audit trail — the invitation row is the record.
    await recordAuditEvent(
      { actorUserId: input.actorUserId, organizationId: input.organizationId, action: "membership.invitation.created", targetType: "organization_invitation", targetId: created!.id, metadata: { roleKey: input.roleKey } },
      tx,
    );
    return created!;
  });
  return invitationDto({ ...row, roleKey: role.key });
}

export async function listInvitations(organizationId: string) {
  const rows = await db
    .select({ invitation: organizationInvitations, roleKey: roles.key })
    .from(organizationInvitations)
    .innerJoin(roles, eq(roles.id, organizationInvitations.roleId))
    .where(eq(organizationInvitations.organizationId, organizationId))
    .orderBy(desc(organizationInvitations.createdAt))
    .limit(100);
  return rows.map((r) => invitationDto({ ...r.invitation, roleKey: r.roleKey }));
}

export async function revokeInvitation(input: { organizationId: string; invitationId: string; actorUserId: string; actorRoleKey: string }) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ invitation: organizationInvitations, roleKey: roles.key })
      .from(organizationInvitations)
      .innerJoin(roles, eq(roles.id, organizationInvitations.roleId))
      .where(and(eq(organizationInvitations.id, input.invitationId), eq(organizationInvitations.organizationId, input.organizationId)))
      .for("update", { of: organizationInvitations });
    if (!row) throw new NotFoundError("Invitation not found");
    assertOwnerRoleChangeAllowed(input.actorRoleKey, [row.roleKey]);
    if (row.invitation.status === "revoked") return invitationDto({ ...row.invitation, roleKey: row.roleKey });
    if (effectiveStatus(row.invitation) !== "pending") throw new ConflictError(`A ${effectiveStatus(row.invitation)} invitation cannot be revoked`);
    const [updated] = await tx
      .update(organizationInvitations)
      .set({ status: "revoked", revokedByUserId: input.actorUserId, revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(organizationInvitations.id, input.invitationId))
      .returning();
    await recordAuditEvent(
      { actorUserId: input.actorUserId, organizationId: input.organizationId, action: "membership.invitation.revoked", targetType: "organization_invitation", targetId: input.invitationId },
      tx,
    );
    return invitationDto({ ...updated!, roleKey: row.roleKey });
  });
}

/** The caller's verified email, lower-cased — or EMAIL_NOT_VERIFIED (never from user_metadata). */
async function verifiedEmailOf(userId: string): Promise<string> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.email || !(await isEmailVerified(userId))) throw new EmailNotVerifiedError();
  return user.email.trim().toLowerCase();
}

/** GET /v1/me/invitations — pending, unexpired invitations addressed to the caller's verified email. */
export async function listMyInvitations(userId: string) {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.email || !(await isEmailVerified(userId))) return { emailVerified: false, invitations: [] };
  const rows = await db
    .select({ invitation: organizationInvitations, roleKey: roles.key, organizationName: organizations.name, organizationStatus: organizations.status })
    .from(organizationInvitations)
    .innerJoin(roles, eq(roles.id, organizationInvitations.roleId))
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(and(eq(organizationInvitations.email, user.email.trim().toLowerCase()), eq(organizationInvitations.status, "pending"), gt(organizationInvitations.expiresAt, sql`now()`)))
    .orderBy(desc(organizationInvitations.createdAt));
  return {
    emailVerified: true,
    invitations: rows.map((r) => ({
      id: r.invitation.id,
      organization: { id: r.invitation.organizationId, name: r.organizationName, status: r.organizationStatus },
      roleKey: r.roleKey,
      expiresAt: r.invitation.expiresAt.toISOString(),
      createdAt: r.invitation.createdAt.toISOString(),
    })),
  };
}

/** Locks the caller's own invitation; anything that is not theirs is simply "not found" (no oracle). */
async function lockMyInvitation(tx: Tx, invitationId: string, email: string) {
  const [row] = await tx
    .select({ invitation: organizationInvitations, roleKey: roles.key })
    .from(organizationInvitations)
    .innerJoin(roles, eq(roles.id, organizationInvitations.roleId))
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.email, email)))
    .for("update", { of: organizationInvitations });
  if (!row) throw new NotFoundError("Invitation not found");
  return row;
}

/**
 * POST /v1/me/invitations/:id/accept — the invited, verified email accepts: an `active` membership with the
 * invited role, in the same transaction that marks the invitation accepted. Accepting again (same person) is
 * idempotent. Refused when the organization is suspended, the invitation is not pending (revoked/declined/
 * expired), the person is already a member, or the plan's members.max no longer has room.
 */
export async function acceptInvitation(userId: string, invitationId: string) {
  const email = await verifiedEmailOf(userId);
  return db.transaction(async (tx) => {
    const { invitation, roleKey } = await lockMyInvitation(tx, invitationId, email);
    if (invitation.status === "accepted" && invitation.respondedByUserId === userId) {
      const [m] = await tx.select().from(memberships).where(and(eq(memberships.organizationId, invitation.organizationId), eq(memberships.userId, userId))).limit(1);
      if (m) return { membershipId: m.id, organizationId: invitation.organizationId, roleKey, created: false };
    }
    const status = effectiveStatus(invitation);
    if (status !== "pending") throw new ConflictError(`This invitation is ${status}`);
    const [org] = await tx.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, invitation.organizationId));
    if (org?.status !== "active") throw new OrganizationSuspendedError();
    const [existing] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.organizationId, invitation.organizationId), eq(memberships.userId, userId))).limit(1);
    if (existing) throw new AlreadyMemberError();
    await assertMemberCapacityInTx(tx, invitation.organizationId, { excludeInvitationId: invitation.id });
    const [membership] = await tx
      .insert(memberships)
      .values({ organizationId: invitation.organizationId, userId, roleId: invitation.roleId, status: "active" })
      .returning();
    await tx
      .update(organizationInvitations)
      .set({ status: "accepted", respondedByUserId: userId, respondedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(organizationInvitations.id, invitation.id));
    await recordAuditEvent(
      { actorUserId: userId, organizationId: invitation.organizationId, action: "membership.invitation.accepted", targetType: "membership", targetId: membership!.id, metadata: { invitationId: invitation.id, roleKey } },
      tx,
    );
    return { membershipId: membership!.id, organizationId: invitation.organizationId, roleKey, created: true };
  });
}

export async function declineInvitation(userId: string, invitationId: string) {
  const email = await verifiedEmailOf(userId);
  return db.transaction(async (tx) => {
    const { invitation } = await lockMyInvitation(tx, invitationId, email);
    if (invitation.status === "declined") return { status: "declined" as const };
    const status = effectiveStatus(invitation);
    if (status !== "pending") throw new ConflictError(`This invitation is ${status}`);
    await tx
      .update(organizationInvitations)
      .set({ status: "declined", respondedByUserId: userId, respondedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(organizationInvitations.id, invitation.id));
    await recordAuditEvent({ actorUserId: userId, organizationId: invitation.organizationId, action: "membership.invitation.declined", targetType: "organization_invitation", targetId: invitation.id }, tx);
    return { status: "declined" as const };
  });
}
