/**
 * Migration 0031 — loads ONLY the typed entitlement definitions and the Na Pista per-module keys of the seeded
 * plans, without running the full seed (which also upserts applications, environments and endpoints that may
 * have been changed in production through the Console). Idempotent, one transaction, every plan value change
 * recorded in plan_entitlement_history (actor `script:load-entitlement-definitions`).
 *
 *   npx tsx scripts/load-entitlement-definitions.ts                                  # DRY RUN: prints what would change
 *   npx tsx scripts/load-entitlement-definitions.ts --apply                          # local
 *   npx tsx scripts/load-entitlement-definitions.ts --apply --confirm-target=<host>  # non-local database
 *
 * Rules: definitions are upserted (src/db/seed/data.ts ENTITLEMENT_DEFINITIONS); for NA_PISTA STARTER and BUSINESS
 * only the per-module keys are ADDED (orders/customers/services.enabled = true, exactly what catalog.enabled
 * unlocked) — an existing value is never changed here; every plan of every application is then validated against
 * the definitions and the whole run refuses on any error. NA_PISTA_GROWTH is loaded by load-na-pista-growth.ts.
 * Applying it to production requires the owner's explicit authorization for this operation.
 */
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, entitlementDefinitions, planEntitlements, plans } from "../src/db/schema/index.js";
import { ENTITLEMENT_DEFINITIONS, PLAN_ENTITLEMENTS } from "../src/db/seed/data.js";
import { loadDefinitions, validatePlanEntitlements } from "../src/modules/entitlements/definitions.js";

const args = new Map(process.argv.slice(2).map((a) => (a.includes("=") ? (a.split(/=(.*)/s).slice(0, 2) as [string, string]) : ([a, "true"] as [string, string]))));
const APPLY = args.get("--apply") === "true";
const CONFIRM_TARGET = args.get("--confirm-target");
export const MODULE_KEYS = ["orders.enabled", "customers.enabled", "services.enabled"] as const;

class DryRun extends Error {}

export async function loadEntitlementDefinitions(opts: { apply: boolean }): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  await db
    .transaction(async (tx) => {
      await tx.execute(sql`select set_config('ul.actor', 'script:load-entitlement-definitions', true)`);
      const apps = new Map((await tx.select({ id: applications.id, key: applications.key }).from(applications)).map((a) => [a.key, a.id]));
      for (const d of ENTITLEMENT_DEFINITIONS) {
        const applicationId = apps.get(d.applicationKey);
        if (!applicationId) throw new Error(`application ${d.applicationKey} not found`);
        const [existing] = await tx.select().from(entitlementDefinitions).where(and(eq(entitlementDefinitions.applicationId, applicationId), eq(entitlementDefinitions.key, d.key)));
        const want = { valueType: d.valueType, module: d.module, requires: [...d.requires], absentPolicy: d.absentPolicy, status: d.status, description: d.description };
        if (!existing) {
          await tx.insert(entitlementDefinitions).values({ applicationId, key: d.key, ...want });
          changes.push(`definition ${d.applicationKey}:${d.key} added (${d.valueType}${d.requires.length ? `, requires ${d.requires.join("+")}` : ""})`);
        } else if (JSON.stringify([existing.valueType, existing.module, existing.requires, existing.absentPolicy, existing.status, existing.description]) !== JSON.stringify(Object.values(want))) {
          await tx.update(entitlementDefinitions).set({ ...want, updatedAt: new Date() }).where(eq(entitlementDefinitions.id, existing.id));
          changes.push(`definition ${d.applicationKey}:${d.key} updated`);
        }
      }
      // NA_PISTA STARTER/BUSINESS: add the per-module keys (never change an existing value).
      for (const planKey of ["STARTER", "BUSINESS"]) {
        const [plan] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.applicationId, apps.get("NA_PISTA")!), eq(plans.key, planKey)));
        if (!plan) continue;
        const existing = new Map((await tx.select().from(planEntitlements).where(eq(planEntitlements.planId, plan.id))).map((e) => [e.key, e.value]));
        if (existing.get("catalog.enabled") !== true) continue;
        for (const key of MODULE_KEYS) {
          const seeded = PLAN_ENTITLEMENTS.find((p) => p.applicationKey === "NA_PISTA" && p.planKey === planKey && p.key === key);
          if (!seeded || existing.has(key)) continue;
          await tx.insert(planEntitlements).values({ planId: plan.id, key, value: seeded.value });
          changes.push(`NA_PISTA/${planKey}: ${key} = ${JSON.stringify(seeded.value)} added`);
        }
      }
      // Every plan of every application must now validate.
      for (const [appKey, appId] of apps) {
        const defs = await loadDefinitions(tx, appKey);
        if (!defs.length) continue;
        for (const plan of await tx.select({ id: plans.id, key: plans.key }).from(plans).where(eq(plans.applicationId, appId))) {
          const rows = await tx.select({ key: planEntitlements.key, value: planEntitlements.value }).from(planEntitlements).where(eq(planEntitlements.planId, plan.id));
          const check = validatePlanEntitlements(rows, defs);
          if (check.errors.length) throw new Error(`plan ${appKey}/${plan.key} does not validate: ${check.errors.join("; ")}`);
          warnings.push(...check.warnings.map((w) => `${appKey}/${plan.key}: ${w}`));
        }
      }
      if (!opts.apply) throw new DryRun();
    })
    .catch((error) => {
      if (!(error instanceof DryRun)) throw error;
    });
  return { changes, warnings };
}

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

async function main() {
  const host = targetHost();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  console.log(`[load-entitlement-definitions] target database host: ${host} — ${APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);
  if (APPLY && !local && CONFIRM_TARGET !== host) throw new Error(`Non-local database: re-run with --confirm-target=${host} to confirm this target explicitly.`);
  const { changes, warnings } = await loadEntitlementDefinitions({ apply: APPLY });
  console.log(changes.length ? changes.map((c) => `  • ${c}`).join("\n") : "  (already up to date — nothing to change)");
  if (warnings.length) console.log(warnings.map((w) => `  ! ${w}`).join("\n"));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main()
    .catch((error) => {
      console.error(`[load-entitlement-definitions] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => queryClient.end());
}
