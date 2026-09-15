import assert from "node:assert/strict";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { APPLICATIONS } from "../src/db/seed/data.js";
import { seed } from "../src/db/seed/index.js";
import { getApplicationByKey, listApplications } from "../src/modules/applications/service.js";
import { NotFoundError } from "../src/shared/errors.js";

after(() => queryClient.end());

test("listApplications returns exactly the seeded platform applications", async () => {
  await seed();
  const applications = await listApplications();
  assert.equal(applications.length, APPLICATIONS.length);

  const keys = applications.map((a) => a.key).sort();
  assert.deepEqual(keys, APPLICATIONS.map((a) => a.key).sort());
});

test("MICHA_EXPRESS is registered; the old MINHA_EXPRESS name never is", async () => {
  await seed();
  const applications = await listApplications();
  assert.ok(applications.some((a) => a.key === "MICHA_EXPRESS"));
  assert.ok(!applications.some((a) => a.key === "MINHA_EXPRESS"));
});

test("getApplicationByKey returns the matching application, ACTIVE by default", async () => {
  await seed();
  const application = await getApplicationByKey("NA_PISTA");
  assert.equal(application.key, "NA_PISTA");
  assert.equal(application.status, "ACTIVE");
});

test("getApplicationByKey throws NotFoundError for an unknown key", async () => {
  await assert.rejects(() => getApplicationByKey("UNKNOWN"), NotFoundError);
});
