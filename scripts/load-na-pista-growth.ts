/**
 * Loads the owner-approved commercial data of the Na Pista pilot (2026-10-15/16) — idempotent, one transaction.
 *
 *   npx tsx scripts/load-na-pista-growth.ts                       # DRY RUN: prints what would change, writes nothing
 *   npx tsx scripts/load-na-pista-growth.ts --apply               # writes (local/staging by default)
 *   npx tsx scripts/load-na-pista-growth.ts --apply --confirm-target=<db host>   # required for a non-local database
 *   … --approve-terms --approved-by=<platform admin user id>      # marks the terms `approved` (see below)
 *
 * What it loads (and nothing else):
 *  - Terms `np-tos-001` v1 = docs/commercial/terms/np-tos-001-draft.md (Annex A + Annex B of the pilot specification),
 *    as `draft` unless --approve-terms. Approval REFUSES while the text still carries draft markers or placeholders
 *    ("RASCUNHO", "[…]", "a completar", "serão definidas", …): the spec itself says to keep the terms in draft until
 *    explicit legal approval. An approved text is immutable (DB trigger); a different approved text needs version 2.
 *  - Plan NA_PISTA / NA_PISTA_GROWTH "Na Pista Crescimento", ACTIVE.
 *  - Its entitlements: catalog.enabled = true, products.max = 500, members.max = 5. NOT advanced_reports.enabled (the
 *    pilot is sold without advanced reports — owner decision 2026-10-15); the script refuses if that key is present.
 *  - Commercial configuration: self_service, 2 500 000 minor (25 000,00 AOA), 30 days, terms np-tos-001.
 *    While the terms are a draft, the catalog lists the plan as NOT contractable (no one can buy it yet).
 *
 * The acceptance consent statement is code (src/modules/commercial/consent.ts, np-tos-* family), not data.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../src/db/index.js";
import { applications, commercialTermsTemplates, planEntitlements, plans, platformMemberships, platformRoles } from "../src/db/schema/index.js";

const args = new Map(process.argv.slice(2).map((a) => (a.includes("=") ? (a.split(/=(.*)/s).slice(0, 2) as [string, string]) : ([a, "true"] as [string, string]))));
const APPLY = args.get("--apply") === "true";
const APPROVE = args.get("--approve-terms") === "true";
const APPROVED_BY = args.get("--approved-by");
const CONFIRM_TARGET = args.get("--confirm-target");

export const TERMS_KEY = "np-tos-001";
export const TERMS_VERSION = 1;
export const TERMS_TITLE = "Termos Padrão de Subscrição — Na Pista (piloto Na Pista Crescimento)";
export const PLAN = { applicationKey: "NA_PISTA", key: "NA_PISTA_GROWTH", name: "Na Pista Crescimento", description: "Plano piloto: catálogo, stock, pedidos, clientes, serviços e marcações; até 500 produtos ativos e 5 utilizadores." };
export const ENTITLEMENTS: Record<string, unknown> = { "catalog.enabled": true, "products.max": 500, "members.max": 5 };
export const FORBIDDEN_ENTITLEMENTS = ["advanced_reports.enabled"];
export const COMMERCIAL = { purchaseMode: "self_service" as const, priceMinor: 2_500_000n, currency: "AOA", periodDays: 30 };

/** Draft markers and placeholders that must be gone before a legal approval. Pure, unit-tested. */
export function draftMarkers(body: string): string[] {
  const found: string[] = [];
  const checks: [string, RegExp][] = [
    ["RASCUNHO", /RASCUNHO/i],
    ["placeholder […]", /\[[^\]]{1,80}\]/],
    ["a completar", /a completar/i],
    ["a preencher", /a preencher/i],
    ["serão definid(a)s", /ser[ãa]o definid[ao]s/i],
    ["devem ser definidos", /devem ser definid[ao]s/i],
    ["serão validadas", /ser[ãa]o validad[ao]s/i],
    ["sujeitos a confirmação", /sujeit[ao]s a confirma[çc][ãa]o/i],
  ];
  for (const [label, re] of checks) if (re.test(body)) found.push(label);
  return found;
}

export function termsBody(): string {
  const raw = readFileSync(path.join(process.cwd(), "docs/commercial/terms/np-tos-001-draft.md"), "utf8");
  return raw.replace(/^<!--[\s\S]*?-->\s*/, "").replace(/\r\n/g, "\n").trim() + "\n";
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
  console.log(`[load-na-pista-growth] target database host: ${host} — ${APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);
  if (APPLY && !local && CONFIRM_TARGET !== host) throw new Error(`Non-local database: re-run with --confirm-target=${host} to confirm this target explicitly.`);

  const body = termsBody();
  const bodySha = createHash("sha256").update(body, "utf8").digest("hex");
  const markers = draftMarkers(body);
  console.log(`terms ${TERMS_KEY} v${TERMS_VERSION}: sha256 ${bodySha.slice(0, 16)}…, ${body.length} chars, draft markers: ${markers.length ? markers.join(", ") : "none"}`);
  if (APPROVE) {
    if (markers.length) throw new Error(`Refusing to approve terms that still contain draft markers/placeholders: ${markers.join(", ")}. Replace the text with the legally approved version first.`);
    if (!APPROVED_BY) throw new Error("--approve-terms needs --approved-by=<user id of the platform admin recording the approval>");
  }

  await db.transaction(async (tx) => {
    const changes: string[] = [];
    const [app] = await tx.select().from(applications).where(eq(applications.key, PLAN.applicationKey));
    if (!app) throw new Error(`Application ${PLAN.applicationKey} not found (seed missing?)`);
    if (APPROVE) {
      const [admin] = await tx
        .select({ id: platformMemberships.userId })
        .from(platformMemberships)
        .innerJoin(platformRoles, eq(platformRoles.id, platformMemberships.platformRoleId))
        .where(and(eq(platformMemberships.userId, APPROVED_BY!), eq(platformMemberships.status, "ACTIVE"), eq(platformRoles.key, "PLATFORM_ADMIN")));
      if (!admin) throw new Error("--approved-by is not an active PLATFORM_ADMIN");
    }

    // 1. Terms
    let [terms] = await tx.select().from(commercialTermsTemplates).where(and(eq(commercialTermsTemplates.key, TERMS_KEY), eq(commercialTermsTemplates.version, TERMS_VERSION)));
    if (!terms) {
      [terms] = await tx
        .insert(commercialTermsTemplates)
        .values({ key: TERMS_KEY, version: TERMS_VERSION, title: TERMS_TITLE, body, bodySha256: bodySha, status: APPROVE ? "approved" : "draft", approvedBy: APPROVE ? APPROVED_BY! : null, approvedAt: APPROVE ? new Date() : null })
        .returning();
      changes.push(`terms ${TERMS_KEY} v${TERMS_VERSION} created as ${terms!.status}`);
    } else if (terms.bodySha256 !== bodySha) {
      if (terms.status !== "draft") throw new Error(`terms ${TERMS_KEY} v${TERMS_VERSION} is ${terms.status} with a different text — immutable; publish the new text as version ${TERMS_VERSION + 1}`);
      [terms] = await tx.update(commercialTermsTemplates).set({ title: TERMS_TITLE, body, bodySha256: bodySha, updatedAt: new Date() }).where(eq(commercialTermsTemplates.id, terms.id)).returning();
      changes.push(`terms ${TERMS_KEY} v${TERMS_VERSION} draft text updated`);
    }
    if (APPROVE && terms!.status === "draft") {
      [terms] = await tx.update(commercialTermsTemplates).set({ status: "approved", approvedBy: APPROVED_BY!, approvedAt: new Date(), updatedAt: new Date() }).where(eq(commercialTermsTemplates.id, terms!.id)).returning();
      changes.push(`terms ${TERMS_KEY} v${TERMS_VERSION} approved`);
    }

    // 2. Plan
    let [plan] = await tx.select().from(plans).where(and(eq(plans.applicationId, app.id), eq(plans.key, PLAN.key)));
    if (!plan) {
      [plan] = await tx.insert(plans).values({ applicationId: app.id, key: PLAN.key, name: PLAN.name, description: PLAN.description }).returning();
      changes.push(`plan ${PLAN.key} created`);
    } else if (plan.name !== PLAN.name || plan.description !== PLAN.description || plan.status !== "ACTIVE") {
      [plan] = await tx.update(plans).set({ name: PLAN.name, description: PLAN.description, status: "ACTIVE", updatedAt: new Date() }).where(eq(plans.id, plan.id)).returning();
      changes.push(`plan ${PLAN.key} name/description/status updated`);
    }

    // 3. Entitlements (exactly these; the forbidden ones must not exist)
    const existing = await tx.select().from(planEntitlements).where(eq(planEntitlements.planId, plan!.id));
    const forbidden = existing.filter((e) => FORBIDDEN_ENTITLEMENTS.includes(e.key));
    if (forbidden.length) throw new Error(`plan ${PLAN.key} has ${forbidden.map((f) => f.key).join(", ")} — not part of the approved pilot; remove it deliberately first`);
    for (const [key, value] of Object.entries(ENTITLEMENTS)) {
      const row = existing.find((e) => e.key === key);
      if (!row) {
        await tx.insert(planEntitlements).values({ planId: plan!.id, key, value });
        changes.push(`entitlement ${key} = ${JSON.stringify(value)} added`);
      } else if (JSON.stringify(row.value) !== JSON.stringify(value)) {
        await tx.update(planEntitlements).set({ value }).where(eq(planEntitlements.id, row.id));
        changes.push(`entitlement ${key}: ${JSON.stringify(row.value)} → ${JSON.stringify(value)}`);
      }
    }

    // 4. Commercial configuration
    const want = { purchaseMode: COMMERCIAL.purchaseMode, priceMinor: COMMERCIAL.priceMinor, currency: COMMERCIAL.currency, periodDays: COMMERCIAL.periodDays, termsTemplateId: terms!.id };
    if (plan!.purchaseMode !== want.purchaseMode || plan!.priceMinor !== want.priceMinor || plan!.currency !== want.currency || plan!.periodDays !== want.periodDays || plan!.termsTemplateId !== want.termsTemplateId) {
      await tx.update(plans).set({ ...want, updatedAt: new Date() }).where(eq(plans.id, plan!.id));
      changes.push(`commercial: self_service, 25 000,00 AOA / 30 days, terms ${TERMS_KEY} (${terms!.status})`);
    }

    console.log(changes.length ? changes.map((c) => `  • ${c}`).join("\n") : "  (already up to date — nothing to change)");
    console.log(`state: terms ${terms!.status}; plan ${PLAN.key} ${terms!.status === "approved" ? "CONTRACTABLE" : "listed but NOT contractable until the terms are approved"}`);
    if (!APPLY) throw new DryRun();
  }).catch((error) => {
    if (error instanceof DryRun) {
      console.log("DRY RUN — rolled back, nothing written.");
      return;
    }
    throw error;
  });
}

class DryRun extends Error {}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main()
    .catch((error) => {
      console.error(`[load-na-pista-growth] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => queryClient.end());
}
