import { eq } from "drizzle-orm";
import type { db as Db } from "../../db/index.js";
import { applications, entitlementDefinitions } from "../../db/schema/index.js";

/**
 * Migration 0031 — typed entitlement definitions and the plan validation that uses them. Pure functions
 * here are unit tested; the seed and the loader scripts call `validatePlanEntitlements` before writing,
 * so a plan can no longer carry an unknown key, a value of the wrong type or an unmet dependency.
 */
export interface EntitlementDefinitionInput {
  key: string;
  valueType: "boolean" | "limit";
  module: string | null;
  requires: readonly string[];
  absentPolicy: "deny" | "unlimited";
  status: "active" | "deprecated";
}

export interface PlanEntitlementCheck {
  errors: string[];
  warnings: string[];
}

/** A limit is a non-negative safe integer; a boolean is exactly true/false. Nothing else is a valid value. */
export function valueMatchesType(valueType: EntitlementDefinitionInput["valueType"], value: unknown): boolean {
  if (valueType === "boolean") return value === true || value === false;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Checks one plan's full entitlement set against its application's definitions.
 *  - unknown key / wrong value type / unmet `requires` (the required key must be present and true in the same plan) → error
 *  - deprecated key still present → warning (kept for compatibility until removed deliberately)
 * A dependency is only checked when the dependent boolean is true: `orders.enabled = false` needs nothing.
 */
export function validatePlanEntitlements(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  definitions: ReadonlyArray<EntitlementDefinitionInput>,
): PlanEntitlementCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const values = new Map(entries.map((e) => [e.key, e.value]));
  for (const { key, value } of entries) {
    const def = byKey.get(key);
    if (!def) {
      errors.push(`${key}: no entitlement definition for this application`);
      continue;
    }
    if (!valueMatchesType(def.valueType, value)) errors.push(`${key}: ${JSON.stringify(value)} is not a valid ${def.valueType}`);
    if (def.status === "deprecated") warnings.push(`${key}: deprecated definition`);
    const active = def.valueType === "limit" || value === true;
    if (active) {
      for (const required of def.requires) {
        if (values.get(required) !== true) errors.push(`${key} requires ${required} = true in the same plan`);
      }
    }
  }
  return { errors, warnings };
}

/** The persisted definitions of one application, in the shape `validatePlanEntitlements` takes. */
export async function loadDefinitions(executor: Pick<typeof Db, "select">, applicationKey: string): Promise<EntitlementDefinitionInput[]> {
  const rows = await executor
    .select({
      key: entitlementDefinitions.key,
      valueType: entitlementDefinitions.valueType,
      module: entitlementDefinitions.module,
      requires: entitlementDefinitions.requires,
      absentPolicy: entitlementDefinitions.absentPolicy,
      status: entitlementDefinitions.status,
    })
    .from(entitlementDefinitions)
    .innerJoin(applications, eq(applications.id, entitlementDefinitions.applicationId))
    .where(eq(applications.key, applicationKey));
  return rows;
}
