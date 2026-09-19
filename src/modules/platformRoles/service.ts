import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { platformRoles } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";

export async function getPlatformRoleByKey(key: string, executor: Pick<typeof db, "select"> = db) {
  const [role] = await executor.select().from(platformRoles).where(eq(platformRoles.key, key)).limit(1);
  if (!role) throw new NotFoundError(`Unknown platform role: ${key}`);
  return role;
}

export async function getPlatformRoleById(id: string) {
  const [role] = await db.select().from(platformRoles).where(eq(platformRoles.id, id)).limit(1);
  if (!role) throw new NotFoundError(`Unknown platform role id: ${id}`);
  return role;
}
