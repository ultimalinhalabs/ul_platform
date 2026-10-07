import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { applications, organizationApplicationAccess, organizations, users } from "../src/db/schema/index.js";

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
