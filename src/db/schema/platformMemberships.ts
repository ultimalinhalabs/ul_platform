import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { platformRoles } from "./platformRoles.js";
import { users } from "./users.js";

/**
 * A User's platform-authority assignment — the control-plane counterpart
 * of `memberships` (which assigns a User an Organization role). Deliberately
 * NOT an extra row/column on `memberships`: an Organization Membership is
 * scoped to one Organization and answers "what can this user do *inside*
 * this tenant"; a Platform Membership has no Organization dimension at all
 * — it answers "can this user administer the platform's own infrastructure".
 * Being an OWNER of every Organization the user has ever touched implies
 * nothing here, and holding a Platform Membership implies nothing about any
 * Organization Membership — the two tables share no foreign key.
 *
 * Unique on `userId` alone (not `(userId, roleId)` like `memberships` is
 * unique on `(userId, organizationId)`): there is exactly one platform to
 * administer, not many tenants, so a user has at most one active platform
 * role assignment. `status` is a small ACTIVE/REVOKED lifecycle — revoking
 * is a status change, never a delete, so the audit trail and the "who was
 * ever a platform admin" history survive removal (same posture already
 * established for API keys, webhook endpoints and environments/endpoints).
 */
export const platformMemberships = pgTable(
  "platform_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platformRoleId: uuid("platform_role_id")
      .notNull()
      .references(() => platformRoles.id),
    status: text("status", { enum: ["ACTIVE", "REVOKED"] })
      .notNull()
      .default("ACTIVE"),
    ...timestamps,
  },
  (table) => [uniqueIndex("platform_memberships_user_unique").on(table.userId)],
);
