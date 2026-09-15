import assert from "node:assert/strict";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { listMembershipsForUser } from "../src/modules/memberships/service.js";
import { createTestUser, deleteTestUser } from "./helpers.js";

after(() => queryClient.end());

test("a user can exist with zero organizations", async () => {
  const user = await createTestUser("identity-no-org");

  try {
    assert.ok(user.id);
    const memberships = await listMembershipsForUser(user.id);
    assert.deepEqual(memberships, []);
  } finally {
    await deleteTestUser(user.id);
  }
});
