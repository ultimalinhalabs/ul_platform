import { and, count, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { db } from "../../db/index.js";
import { memberships, organizationInvitations, planEntitlements, subscriptions } from "../../db/schema/index.js";
import { AppError } from "../../shared/errors.js";
import { SUBSCRIPTION_EFFECTIVE } from "../entitlements/effectiveness.js";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The number of people an organization may have — the `members.max`
 * entitlement of its plan (owner-approved Na Pista Crescimento: 5 users per
 * organization). Memberships are UL Platform's, so UL enforces it here, on
 * every path that makes a membership count: creating one, and moving a
 * suspended one back to active/invited, and (migration 0025) inviting someone
 * by email. `active` and `invited` memberships count, and so does every
 * PENDING, unexpired invitation (it reserves a place, so invitations can never
 * overbook the plan); `suspended` does not (it grants no access).
 *
 * The limit is read from the organization's EFFECTIVE subscriptions
 * (entitlements/effectiveness.ts): with several plans the largest
 * `members.max` applies (a person is a member of the organization, not of
 * one application); with no effective plan setting it there is no limit. A
 * present but invalid value fails closed. A downgrade below the current count
 * removes nobody — only new members are refused.
 */
export const MEMBERS_LIMIT_KEY = "members.max";
export const COUNTED_MEMBERSHIP_STATUSES = ["active", "invited"] as const;

export class MemberLimitExceededError extends AppError {
  constructor(message: string) {
    super(409, "LIMIT_EXCEEDED", message);
  }
}

export async function resolveMemberLimit(executor: Executor, organizationId: string): Promise<number | null> {
  const rows = await executor
    .select({ value: planEntitlements.value })
    .from(subscriptions)
    .innerJoin(planEntitlements, and(eq(planEntitlements.planId, subscriptions.planId), eq(planEntitlements.key, MEMBERS_LIMIT_KEY)))
    .where(and(eq(subscriptions.organizationId, organizationId), SUBSCRIPTION_EFFECTIVE));
  if (rows.length === 0) return null;
  const values = rows.map((r) => r.value);
  if (values.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 0)) {
    throw new MemberLimitExceededError(`The organization's plan has an invalid "${MEMBERS_LIMIT_KEY}"`);
  }
  return Math.max(...(values as number[]));
}

/**
 * Inside the transaction that adds/reactivates a membership or creates/accepts an invitation: serialized per
 * organization, so concurrent requests cannot overshoot. `excludeInvitationId`: the invitation being accepted
 * already holds its place — it is converted, not added.
 */
export async function assertMemberCapacityInTx(tx: Executor, organizationId: string, opts: { excludeInvitationId?: string } = {}): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ul.memberships.counted:${organizationId}`}, 0))`);
  const max = await resolveMemberLimit(tx, organizationId);
  if (max === null) return;
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), inArray(memberships.status, [...COUNTED_MEMBERSHIP_STATUSES])));
  const [invited] = await tx
    .select({ n: count() })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.status, "pending"),
        gt(organizationInvitations.expiresAt, sql`now()`),
        ...(opts.excludeInvitationId ? [ne(organizationInvitations.id, opts.excludeInvitationId)] : []),
      ),
    );
  if ((row?.n ?? 0) + (invited?.n ?? 0) >= max) throw new MemberLimitExceededError(`The organization's plan allows at most ${max} members`);
}
