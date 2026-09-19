import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications } from "../../db/schema/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { ConflictError, NotFoundError, isUniqueViolationError } from "../../shared/errors.js";

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

/**
 * Registers a new product/consumer of the platform — the first mutation
 * this registry has ever had over HTTP (Phase 12 shipped Environments/
 * Endpoints/Integrations read-only for the same reason this was read-only
 * until now: no `PLATFORM_ADMIN` to gate it behind). Deliberately no
 * "REGISTERED"/pending pre-active state — see db/schema/applications.ts;
 * a new application is `ACTIVE` immediately, the same lifecycle default
 * every other row-creating flow in this codebase already uses.
 */
export async function createApplication(input: {
  key: string;
  name: string;
  description?: string;
  actorUserId?: string;
}) {
  let row: { key: string; name: string; description: string | null; status: string };
  try {
    const [inserted] = await db
      .insert(applications)
      .values({ key: input.key, name: input.name, description: input.description })
      .returning(SELECTABLE);
    if (!inserted) throw new Error("Failed to create application");
    row = inserted;
  } catch (error) {
    if (isUniqueViolationError(error)) {
      throw new ConflictError(`Application "${input.key}" already exists`);
    }
    throw error;
  }

  await recordAuditEvent({
    actorUserId: input.actorUserId,
    action: "platform.application.created",
    targetType: "application",
    targetId: input.key,
    metadata: { key: input.key, name: input.name },
  });

  return row;
}

/**
 * `status` transitions stay within the existing ACTIVE/SUSPENDED/DEPRECATED
 * lifecycle (db/schema/applications.ts) — no new states invented here, and
 * there is deliberately no delete: `plans.applicationId` is `ON DELETE
 * RESTRICT`, so an application with any commercial history physically
 * cannot be deleted, and lifecycle status is the intended lever instead.
 */
export async function updateApplication(
  key: string,
  patch: { name?: string; description?: string; status?: "ACTIVE" | "SUSPENDED" | "DEPRECATED" },
  actorUserId?: string,
) {
  const [updated] = await db
    .update(applications)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(applications.key, key))
    .returning(SELECTABLE);
  if (!updated) throw new NotFoundError(`Unknown application: ${key}`);

  await recordAuditEvent({
    actorUserId,
    action: "platform.application.updated",
    targetType: "application",
    targetId: key,
    metadata: patch,
  });

  return updated;
}
