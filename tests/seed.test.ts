import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, queryClient } from "../src/db/index.js";

after(() => queryClient.end());
import { APPLICATIONS, PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../src/db/seed/data.js";
import { seed } from "../src/db/seed/index.js";
import { applications, permissions, rolePermissions, roles } from "../src/db/schema/index.js";

const expectedRolePermissionCount = Object.values(ROLE_PERMISSIONS).reduce(
  (sum, keys) => sum + keys.length,
  0,
);

async function countRows(table: PgTable) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row!.count;
}

test("seed is idempotent: running it twice does not duplicate rows", async () => {
  await seed();
  await seed();

  assert.equal(await countRows(applications), APPLICATIONS.length);
  assert.equal(await countRows(permissions), PERMISSIONS.length);
  assert.equal(await countRows(roles), ROLES.length);
  assert.equal(await countRows(rolePermissions), expectedRolePermissionCount);
});
