import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { roles } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";

export async function getRoleByKey(key: string, executor: Pick<typeof db, "select"> = db) {
  const [role] = await executor.select().from(roles).where(eq(roles.key, key)).limit(1);
  if (!role) throw new NotFoundError(`Unknown role: ${key}`);
  return role;
}
