/**
 * Migration 0031 — records what kind of relationship each pre-0031 subscription is (`subscriptions.origin`),
 * one subscription at a time, as decided by the owner. Classification is informational: it never changes
 * what a subscription grants, its period or its status (expiring/revoking stays a separate, explicit decision).
 *
 *   npx tsx scripts/classify-subscriptions.ts --list                                   # unclassified subscriptions (id prefixes, no names)
 *   npx tsx scripts/classify-subscriptions.ts --set=<subscriptionId>:<origin>[,…]      # DRY RUN
 *   npx tsx scripts/classify-subscriptions.ts --set=… --apply [--confirm-target=<db host>]
 *
 * <origin> ∈ commercial | demo | test | legacy. Only a NULL origin is set; a classified row is never changed
 * silently (refuses). Each change is written to audit_logs (`subscription.classified`).
 * Applying it to production requires the owner's explicit authorization for this operation.
 */
import path from "node:path";
import { eq, isNull } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, plans, SUBSCRIPTION_ORIGINS, subscriptions } from "../src/db/schema/index.js";
import { recordAuditEventStrict } from "../src/modules/audit/service.js";

type Origin = (typeof SUBSCRIPTION_ORIGINS)[number];

const args = new Map(process.argv.slice(2).map((a) => (a.includes("=") ? (a.split(/=(.*)/s).slice(0, 2) as [string, string]) : ([a, "true"] as [string, string]))));
const APPLY = args.get("--apply") === "true";
const CONFIRM_TARGET = args.get("--confirm-target");

/** Pure: parses `id:origin,id:origin`; refuses unknown origins, malformed ids and duplicates. Unit-tested. */
export function parseClassification(spec: string): Array<{ subscriptionId: string; origin: Origin }> {
  const out: Array<{ subscriptionId: string; origin: Origin }> = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [id, origin] = part.split(":");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`"${part}": expected <full subscription uuid>:<origin>`);
    if (!SUBSCRIPTION_ORIGINS.includes(origin as Origin)) throw new Error(`"${part}": origin must be one of ${SUBSCRIPTION_ORIGINS.join(", ")}`);
    if (out.some((o) => o.subscriptionId === id)) throw new Error(`"${id}" appears twice`);
    out.push({ subscriptionId: id, origin: origin as Origin });
  }
  if (!out.length) throw new Error("nothing to classify");
  return out;
}

export async function classify(items: Array<{ subscriptionId: string; origin: Origin }>, opts: { apply: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    for (const { subscriptionId, origin } of items) {
      const [row] = await tx.select({ id: subscriptions.id, origin: subscriptions.origin, organizationId: subscriptions.organizationId }).from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for("update");
      if (!row) throw new Error(`subscription ${subscriptionId.slice(0, 8)} not found`);
      if (row.origin !== null) throw new Error(`subscription ${subscriptionId.slice(0, 8)} is already classified as ${row.origin} — refusing to change it silently`);
      await tx.update(subscriptions).set({ origin }).where(eq(subscriptions.id, subscriptionId));
      await recordAuditEventStrict({ organizationId: row.organizationId, action: "subscription.classified", targetType: "subscription", targetId: subscriptionId, metadata: { origin, by: "script:classify-subscriptions" } }, tx);
      console.log(`  • ${subscriptionId.slice(0, 8)} → ${origin}`);
    }
    if (!opts.apply) throw new DryRun();
  }).catch((error) => {
    if (!(error instanceof DryRun)) throw error;
  });
}

class DryRun extends Error {}

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

async function main() {
  const host = targetHost();
  if (args.get("--list") === "true") {
    const rows = await db
      .select({ id: subscriptions.id, org: subscriptions.organizationId, app: applications.key, plan: plans.key, end: subscriptions.currentPeriodEnd })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(applications, eq(applications.id, plans.applicationId))
      .where(isNull(subscriptions.origin));
    for (const r of rows) console.log(`  ${r.id}  org ${r.org.slice(0, 8)}  ${r.app}/${r.plan}  end ${r.end?.toISOString() ?? "—"}`);
    console.log(`${rows.length} unclassified subscription(s) on ${host}`);
    return;
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  console.log(`[classify-subscriptions] target database host: ${host} — ${APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);
  if (APPLY && !local && CONFIRM_TARGET !== host) throw new Error(`Non-local database: re-run with --confirm-target=${host} to confirm this target explicitly.`);
  await classify(parseClassification(args.get("--set") ?? ""), { apply: APPLY });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main()
    .catch((error) => {
      console.error(`[classify-subscriptions] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => queryClient.end());
}
