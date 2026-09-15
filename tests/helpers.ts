import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { organizations, users } from "../src/db/schema/index.js";

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
