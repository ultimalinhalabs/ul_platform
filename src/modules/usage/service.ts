import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applicationMeters, applications, meters, organizations, usageEvents } from "../../db/schema/index.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";

interface MeterRow {
  id: string;
  key: string;
  unit: string;
}

async function getApplication(applicationKey: string): Promise<{ id: string; key: string; name: string }> {
  const [application] = await db
    .select({ id: applications.id, key: applications.key, name: applications.name })
    .from(applications)
    .where(eq(applications.key, applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${applicationKey}`);
  return application;
}

/**
 * In production `organizationId` always comes from an already-authenticated
 * service credential's own stored row, so this can never actually fail —
 * this check exists purely so a bogus id (e.g. a stale/synthetic caller)
 * fails with a clean `NotFoundError` instead of an unhandled Postgres
 * foreign-key violation leaking out of `recordUsage` as a raw 500.
 */
async function assertOrganizationExists(organizationId: string): Promise<void> {
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!row) throw new NotFoundError(`Unknown organization: ${organizationId}`);
}

/**
 * Write-path validation: distinguishes "this meter doesn't exist"
 * (`NotFoundError`, 400-shaped — the caller typed something that was never
 * a meter) from "this meter exists but this application may never record
 * against it" (`ForbiddenError`, 403 — a real capability this application
 * doesn't hold), exactly mirroring `serviceScopes.validateRequestedScopes`.
 */
async function validateMeterForApplication(
  applicationId: string,
  applicationKey: string,
  meterKey: string,
): Promise<MeterRow> {
  const [meter] = await db
    .select({ id: meters.id, key: meters.key, unit: meters.unit })
    .from(meters)
    .where(eq(meters.key, meterKey))
    .limit(1);
  if (!meter) throw new NotFoundError(`Unknown meter: ${meterKey}`);

  const [allowed] = await db
    .select({ meterId: applicationMeters.meterId })
    .from(applicationMeters)
    .where(and(eq(applicationMeters.applicationId, applicationId), eq(applicationMeters.meterId, meter.id)))
    .limit(1);
  if (!allowed) {
    throw new ForbiddenError(`Application "${applicationKey}" is not authorized for meter "${meterKey}"`);
  }

  return meter;
}

/**
 * Read-path resolution: a single uniform `NotFoundError` whether the meter
 * key doesn't exist at all or simply isn't associated with this
 * application — a read has no escalation risk to distinguish from a typo,
 * so both cases get the same honest answer ("no such usage metric for
 * this application"), mirroring `getEffectiveEntitlement`'s uniform 404.
 */
async function resolveApplicationMeter(applicationId: string, meterKey: string): Promise<MeterRow> {
  const [row] = await db
    .select({ id: meters.id, key: meters.key, unit: meters.unit })
    .from(meters)
    .innerJoin(applicationMeters, eq(applicationMeters.meterId, meters.id))
    .where(and(eq(meters.key, meterKey), eq(applicationMeters.applicationId, applicationId)))
    .limit(1);
  if (!row) throw new NotFoundError(`No such meter "${meterKey}" for this application`);
  return row;
}

export interface RecordUsageInput {
  organizationId: string;
  applicationKey: string;
  meterKey: string;
  /** Already-normalized decimal string — see modules/usage/schemas.ts. */
  quantity: string;
  occurredAt?: Date;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

function shapeUsageEvent(row: typeof usageEvents.$inferSelect, meter: MeterRow, applicationKey: string) {
  return {
    id: row.id,
    application: applicationKey,
    organizationId: row.organizationId,
    meter: { key: meter.key, unit: meter.unit },
    quantity: Number(row.quantity),
    occurredAt: row.occurredAt,
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata,
  };
}

/**
 * Records one usage event. Idempotent by construction: `idempotencyKey` is
 * part of a real unique index (`usage_events_idempotency_unique`), so a
 * retried submission with the same key never counts twice — the insert
 * conflicts, and the *original* row is re-selected and returned instead.
 * This is safe under concurrent duplicate submissions without any
 * application-level locking: Postgres resolves the unique-index race, not
 * this function.
 */
export async function recordUsage(
  input: RecordUsageInput,
): Promise<ReturnType<typeof shapeUsageEvent> & { idempotent: boolean }> {
  const application = await getApplication(input.applicationKey);
  const meter = await validateMeterForApplication(application.id, application.key, input.meterKey);
  await assertOrganizationExists(input.organizationId);

  const [inserted] = await db
    .insert(usageEvents)
    .values({
      organizationId: input.organizationId,
      applicationId: application.id,
      meterId: meter.id,
      quantity: input.quantity,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    })
    .onConflictDoNothing({
      target: [usageEvents.organizationId, usageEvents.applicationId, usageEvents.meterId, usageEvents.idempotencyKey],
    })
    .returning();

  if (inserted) {
    return { ...shapeUsageEvent(inserted, meter, application.key), idempotent: false };
  }

  const [existing] = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.organizationId, input.organizationId),
        eq(usageEvents.applicationId, application.id),
        eq(usageEvents.meterId, meter.id),
        eq(usageEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Usage event conflicted but could not be re-read");

  return { ...shapeUsageEvent(existing, meter, application.key), idempotent: true };
}

export interface UsageRange {
  from?: Date;
  to?: Date;
}

/**
 * Aggregates at query time — no materialized/cached totals (see README
 * "Aggregation"). A range with no matching rows is a real, meaningful
 * zero, not an error: an organization simply hasn't generated that usage
 * yet, matching the platform's established "empty state is not a 404"
 * posture (see Effective Entitlements).
 */
export async function getUsageForMeter(input: {
  organizationId: string;
  applicationKey: string;
  meterKey: string;
  range?: UsageRange;
}) {
  const application = await getApplication(input.applicationKey);
  const meter = await resolveApplicationMeter(application.id, input.meterKey);

  const conditions = [
    eq(usageEvents.organizationId, input.organizationId),
    eq(usageEvents.applicationId, application.id),
    eq(usageEvents.meterId, meter.id),
  ];
  if (input.range?.from) conditions.push(gte(usageEvents.occurredAt, input.range.from));
  if (input.range?.to) conditions.push(lte(usageEvents.occurredAt, input.range.to));

  const [row] = await db
    .select({ total: sql<string | null>`sum(${usageEvents.quantity})` })
    .from(usageEvents)
    .where(and(...conditions));

  return {
    application: { key: application.key, name: application.name },
    meter: { key: meter.key, unit: meter.unit },
    period: { from: input.range?.from ?? null, to: input.range?.to ?? null },
    quantity: row?.total ? Number(row.total) : 0,
  };
}

/** Only meters this (organization, application) actually has recorded events for — not every allowed meter padded with zeroes. */
export async function getUsageForApplication(input: {
  organizationId: string;
  applicationKey: string;
  range?: UsageRange;
}) {
  const application = await getApplication(input.applicationKey);

  const conditions = [
    eq(usageEvents.organizationId, input.organizationId),
    eq(usageEvents.applicationId, application.id),
  ];
  if (input.range?.from) conditions.push(gte(usageEvents.occurredAt, input.range.from));
  if (input.range?.to) conditions.push(lte(usageEvents.occurredAt, input.range.to));

  const rows = await db
    .select({
      meterKey: meters.key,
      meterUnit: meters.unit,
      total: sql<string | null>`sum(${usageEvents.quantity})`,
    })
    .from(usageEvents)
    .innerJoin(meters, eq(meters.id, usageEvents.meterId))
    .where(and(...conditions))
    .groupBy(meters.key, meters.unit)
    .orderBy(meters.key);

  return {
    application: { key: application.key, name: application.name },
    period: { from: input.range?.from ?? null, to: input.range?.to ?? null },
    meters: rows.map((r) => ({
      meter: { key: r.meterKey, unit: r.meterUnit },
      quantity: r.total ? Number(r.total) : 0,
    })),
  };
}

export async function listMeters() {
  return db.select({ key: meters.key, unit: meters.unit, description: meters.description }).from(meters).orderBy(meters.key);
}

export async function listApplicationMeters(applicationKey: string) {
  const application = await getApplication(applicationKey);
  const rows = await db
    .select({ key: meters.key, unit: meters.unit, description: meters.description })
    .from(applicationMeters)
    .innerJoin(meters, eq(meters.id, applicationMeters.meterId))
    .where(eq(applicationMeters.applicationId, application.id))
    .orderBy(meters.key);
  return { application: { key: application.key, name: application.name }, meters: rows };
}
