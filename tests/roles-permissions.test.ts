import assert from "node:assert/strict";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { ROLE_PERMISSIONS, ROLES, PERMISSIONS } from "../src/db/seed/data.js";
import { seed } from "../src/db/seed/index.js";
import { getPermissionByKey, listPermissions } from "../src/modules/permissions/service.js";
import { getRoleDetail, listRoles } from "../src/modules/roles/service.js";
import { NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("listRoles returns the seeded platform role catalog", async () => {
  await seed();
  const roles = await listRoles();
  assert.equal(roles.length, ROLES.length);
  for (const role of ROLES) {
    assert.ok(roles.some((r) => r.key === role.key && r.name === role.name));
  }
});

test("getRoleDetail includes exactly the role's seeded permissions", async () => {
  await seed();
  const detail = await getRoleDetail("MANAGER");
  assert.equal(detail.key, "MANAGER");
  const keys = detail.permissions.map((p) => p.key).sort();
  assert.deepEqual(keys, [...ROLE_PERMISSIONS.MANAGER].sort());
});

test("getRoleDetail throws NotFoundError for an unknown role", async () => {
  await assert.rejects(() => getRoleDetail("NOT_A_ROLE"), NotFoundError);
});

test("listPermissions returns the seeded permission catalog", async () => {
  await seed();
  const permissions = await listPermissions();
  assert.equal(permissions.length, PERMISSIONS.length);
});

test("getPermissionByKey returns the matching permission", async () => {
  await seed();
  const permission = await getPermissionByKey("organization.read");
  assert.equal(permission.key, "organization.read");
});

test("getPermissionByKey throws NotFoundError for an unknown key", async () => {
  await assert.rejects(() => getPermissionByKey("not.a.permission"), NotFoundError);
});
