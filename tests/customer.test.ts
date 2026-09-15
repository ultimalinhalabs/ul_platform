import assert from "node:assert/strict";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { customers } from "../src/db/schema/index.js";

after(() => queryClient.end());
import { findActiveMembership } from "../src/modules/memberships/service.js";
import { createTestOrganization, createTestUser, deleteTestOrganization, deleteTestUser } from "./helpers.js";

test("a Customer relationship exists without granting Membership access", async () => {
  const user = await createTestUser("customer-not-member");
  const org = await createTestOrganization("customer-not-member");

  await db.insert(customers).values({ userId: user.id, organizationId: org.id });

  try {
    const [customerRow] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.userId, user.id), eq(customers.organizationId, org.id)));
    assert.ok(customerRow, "customer relationship should exist");

    const membership = await findActiveMembership(user.id, org.id);
    assert.equal(membership, null, "a customer must not implicitly be a member");
  } finally {
    await deleteTestOrganization(org.id); // cascades the customer row
    await deleteTestUser(user.id);
  }
});
