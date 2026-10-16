import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { applications, commercialPayments, contracts, organizationApplicationAccess, organizations, users } from "../src/db/schema/index.js";
import { isUniqueViolationError } from "../src/shared/errors.js";

export async function createTestUser(emailPrefix: string) {
  const id = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ id, email: `${emailPrefix}+${id}@test.ul-platform.invalid` })
    .returning();
  return row!;
}

export async function createTestOrganization(namePrefix: string, createdBy?: string) {
  const slug = `${namePrefix}-${randomUUID()}`;
  const [row] = await db
    .insert(organizations)
    .values({ name: slug, slug, createdBy })
    .returning();
  return row!;
}

export async function deleteTestUser(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

export async function deleteTestOrganization(organizationId: string) {
  await db.delete(organizations).where(eq(organizations.id, organizationId));
}

/**
 * Block 1D (G6) — organization API keys require the organization's active access to the application.
 * Test setup grants it directly (no audit noise); the row is removed with the organization (FK cascade).
 */
export async function grantTestApplicationAccess(organizationId: string, applicationKey: string) {
  const [application] = await db.select({ id: applications.id }).from(applications).where(eq(applications.key, applicationKey));
  await db
    .insert(organizationApplicationAccess)
    .values({ organizationId, applicationId: application!.id, status: "active" })
    .onConflictDoUpdate({ target: [organizationApplicationAccess.organizationId, organizationApplicationAccess.applicationId], set: { status: "active", revokedAt: null } });
}

/**
 * Migration 0023 — activation requires a confirmed payment. Test setup records a manual confirmation of the
 * contract's exact amount directly (the insert trigger still validates it), only while the contract is pending
 * and unpaid; concurrent callers are tolerated (one row wins the unique index).
 */
export async function confirmTestPayment(contractId: string, confirmedByUserId: string) {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract || contract.status !== "pending_activation") return;
  const [paid] = await db.select({ id: commercialPayments.id }).from(commercialPayments).where(and(eq(commercialPayments.contractId, contractId), eq(commercialPayments.status, "confirmed")));
  if (paid) return;
  try {
    await db.insert(commercialPayments).values({
      contractId,
      organizationId: contract.organizationId,
      source: "manual",
      method: "bank_transfer",
      amountMinor: contract.totalMinor,
      currency: contract.currency,
      externalReference: `test-${randomUUID()}`,
      receivedAt: new Date(),
      confirmedByUserId,
      idempotencyKey: `test-pay-${randomUUID()}`,
    });
  } catch (error) {
    if (!isUniqueViolationError(error)) throw error;
  }
}
