import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";

const SELECTABLE = {
  key: applications.key,
  name: applications.name,
  description: applications.description,
  status: applications.status,
} as const;

/** Platform application registry, for read-only display. */
export async function listApplications() {
  return db.select(SELECTABLE).from(applications).orderBy(applications.key);
}

export async function getApplicationByKey(key: string) {
  const [application] = await db
    .select(SELECTABLE)
    .from(applications)
    .where(eq(applications.key, key))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${key}`);
  return application;
}

/**
 * Like `getApplicationByKey`, but includes the internal `id` — needed by
 * every module that stores a real FK to `applications` (usage, environments,
 * endpoints, integrations, ...). `SELECTABLE` above deliberately omits `id`
 * for the public registry read shape; this is the one place internal
 * modules resolve it, so `id` is never accidentally serialized into an API
 * response by reusing this instead of `SELECTABLE`.
 */
export async function getApplicationRecord(
  key: string,
): Promise<{ id: string; key: string; name: string; status: string }> {
  const [application] = await db
    .select({ id: applications.id, key: applications.key, name: applications.name, status: applications.status })
    .from(applications)
    .where(eq(applications.key, key))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${key}`);
  return application;
}
