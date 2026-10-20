/**
 * Migration 0031 — freezes the entitlement values of contractual grants activated BEFORE 0031 (they carry no
 * frozen values, so their effective rights still follow the live plan). One transaction, idempotent.
 *
 *   npx tsx scripts/backfill-grant-entitlement-values.ts                     # DRY RUN: prints what would be frozen
 *   npx tsx scripts/backfill-grant-entitlement-values.ts --apply             # writes (local by default)
 *   npx tsx scripts/backfill-grant-entitlement-values.ts --apply --confirm-target=<db host>   # non-local database
 *   … --grant=<grant uuid>[,<grant uuid>]                                    # only these grants
 *
 * Rules:
 *  - only `active` grants with no frozen value yet; the values are the grant plan's current values, which must
 *    validate against the typed definitions (run the seed and the plan loaders first);
 *  - a NA_PISTA_GROWTH grant must freeze exactly the approved pilot values (scripts/load-na-pista-growth.ts
 *    ENTITLEMENTS = the limits and modules of the accepted terms np-tos-001, clauses A2/A3) — otherwise it refuses;
 *  - every frozen grant gets an `entitlement.values_frozen` commercial event (actor: system).
 * Applying it to production requires the owner's explicit authorization for this operation.
 */
import path from "node:path";
import { and, eq, inArray, notExists } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, entitlementGrants, grantEntitlementValues, planEntitlements, plans } from "../src/db/schema/index.js";
import { recordCommercialEvent } from "../src/modules/commercial/events.js";
import { loadDefinitions, validatePlanEntitlements } from "../src/modules/entitlements/definitions.js";
import { ENTITLEMENTS as GROWTH_APPROVED, PLAN as GROWTH_PLAN } from "./load-na-pista-growth.js";

const args = new Map(process.argv.slice(2).map((a) => (a.includes("=") ? (a.split(/=(.*)/s).slice(0, 2) as [string, string]) : ([a, "true"] as [string, string]))));
const APPLY = args.get("--apply") === "true";
const CONFIRM_TARGET = args.get("--confirm-target");
const ONLY = args.get("--grant")?.split(",").map((g) => g.trim()).filter(Boolean);

/** Pure: the frozen set must equal the approved one exactly (same keys, same JSON values). Unit-tested. */
export function sameEntitlementSet(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

export async function backfill(opts: { apply: boolean; onlyGrantIds?: string[] }): Promise<Array<{ grantId: string; applicationKey: string; planKey: string; values: Record<string, unknown> }>> {
  const planned: Array<{ grantId: string; applicationKey: string; planKey: string; values: Record<string, unknown> }> = [];
  await db.transaction(async (tx) => {
    const grants = await tx
      .select({ id: entitlementGrants.id, organizationId: entitlementGrants.organizationId, planId: entitlementGrants.planId, applicationKey: applications.key, planKey: plans.key })
      .from(entitlementGrants)
      .innerJoin(applications, eq(applications.id, entitlementGrants.applicationId))
      .innerJoin(plans, eq(plans.id, entitlementGrants.planId))
      .where(
        and(
          eq(entitlementGrants.status, "active"),
          ...(opts.onlyGrantIds ? [inArray(entitlementGrants.id, opts.onlyGrantIds)] : []),
          notExists(tx.select({ one: grantEntitlementValues.id }).from(grantEntitlementValues).where(eq(grantEntitlementValues.grantId, entitlementGrants.id))),
        ),
      );
    for (const g of grants) {
      const rows = await tx.select({ key: planEntitlements.key, value: planEntitlements.value }).from(planEntitlements).where(eq(planEntitlements.planId, g.planId!));
      if (rows.length === 0) continue; // nothing to freeze: the grant resolves to the (empty) plan either way
      const values = Object.fromEntries(rows.map((r) => [r.key, r.value as unknown]));
      const check = validatePlanEntitlements(rows, await loadDefinitions(tx, g.applicationKey));
      if (check.errors.length) throw new Error(`grant ${g.id.slice(0, 8)} (${g.applicationKey}/${g.planKey}): plan values invalid — ${check.errors.join("; ")}`);
      if (g.applicationKey === GROWTH_PLAN.applicationKey && g.planKey === GROWTH_PLAN.key && !sameEntitlementSet(values, GROWTH_APPROVED)) {
        throw new Error(`grant ${g.id.slice(0, 8)}: plan ${g.planKey} values ${JSON.stringify(values)} differ from the approved pilot values — load the approved plan first`);
      }
      planned.push({ grantId: g.id, applicationKey: g.applicationKey, planKey: g.planKey, values });
      await tx.insert(grantEntitlementValues).values(rows.map((r) => ({ grantId: g.id, key: r.key, value: r.value, source: "plan" as const })));
      await recordCommercialEvent(tx, {
        aggregateType: "entitlement_grant",
        aggregateId: g.id,
        eventType: "entitlement.values_frozen",
        organizationId: g.organizationId,
        actorType: "system",
        payload: { planKey: g.planKey, values, reason: "backfill: grant activated before migration 0031" },
      });
    }
    if (!opts.apply) throw new DryRun();
  }).catch((error) => {
    if (!(error instanceof DryRun)) throw error;
  });
  return planned;
}

class DryRun extends Error {}

async function main() {
  const host = targetHost();
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  console.log(`[backfill-grant-entitlement-values] target database host: ${host} — ${APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);
  if (APPLY && !local && CONFIRM_TARGET !== host) throw new Error(`Non-local database: re-run with --confirm-target=${host} to confirm this target explicitly.`);
  const planned = await backfill({ apply: APPLY, onlyGrantIds: ONLY });
  if (!planned.length) console.log("  (no active grant without frozen values — nothing to do)");
  for (const p of planned) console.log(`  • grant ${p.grantId.slice(0, 8)} ${p.applicationKey}/${p.planKey}: ${JSON.stringify(p.values)}`);
  console.log(APPLY ? `frozen ${planned.length} grant(s)` : `would freeze ${planned.length} grant(s)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main()
    .catch((error) => {
      console.error(`[backfill-grant-entitlement-values] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => queryClient.end());
}
