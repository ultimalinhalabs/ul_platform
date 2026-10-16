import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { roles } from "./roles.js";
import { users } from "./users.js";

export const INVITATION_STATUSES = ["pending", "accepted", "declined", "revoked", "expired"] as const;

/**
 * Migration 0025 — team invitations by email (F17 Gap 1). An OWNER/ADMIN
 * (`membership.create`) invites an email address with a role; the person
 * accepts it themselves, signed in with that VERIFIED email, and only then a
 * real membership exists. No user lookup by email is ever exposed (no
 * enumeration), and there is no secret token: the invitation is bound to the
 * email address, and acceptance requires the identity provider to have
 * verified it.
 *
 * A pending, unexpired invitation takes a place under the plan's
 * `members.max` (memberships/memberLimit.ts), so invitations can never
 * overbook the plan. At most one pending invitation per (organization,
 * email). `email` is stored lower-cased. UL Platform does not send email:
 * delivery is the caller's (or a future notification service's) concern.
 */
export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    status: text("status", { enum: INVITATION_STATUSES }).notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedByUserId: uuid("responded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_invitations_one_pending").on(table.organizationId, table.email).where(sql`${table.status} = 'pending'`),
    index("organization_invitations_email_pending_idx").on(table.email).where(sql`${table.status} = 'pending'`),
    check("organization_invitations_status_check", sql`${table.status} in ('pending', 'accepted', 'declined', 'revoked', 'expired')`),
    check("organization_invitations_email_check", sql`${table.email} = lower(${table.email}) and ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
    check("organization_invitations_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
