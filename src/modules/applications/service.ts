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
