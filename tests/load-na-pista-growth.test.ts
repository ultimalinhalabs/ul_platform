import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { queryClient } from "../src/db/index.js";
import { COMMERCIAL, ENTITLEMENTS, FORBIDDEN_ENTITLEMENTS, PLAN, TERMS_KEY, draftMarkers, termsBody } from "../scripts/load-na-pista-growth.js";
import { currentAcceptanceConsent } from "../src/modules/commercial/consent.js";

/** The approved-data loader (scripts/load-na-pista-growth.ts): exactly the owner-approved values; draft terms are never approvable. */

after(async () => {
  await queryClient.end();
});

test("the loader carries exactly the approved pilot values", () => {
  assert.equal(PLAN.key, "NA_PISTA_GROWTH");
  assert.equal(PLAN.name, "Na Pista Crescimento");
  assert.deepEqual(ENTITLEMENTS, { "catalog.enabled": true, "products.max": 500, "members.max": 5 });
  assert.ok(FORBIDDEN_ENTITLEMENTS.includes("advanced_reports.enabled"), "sold without advanced reports");
  assert.equal(COMMERCIAL.priceMinor, 2_500_000n);
  assert.equal(COMMERCIAL.currency, "AOA");
  assert.equal(COMMERCIAL.periodDays, 30);
  assert.equal(COMMERCIAL.purchaseMode, "self_service");
});

test("the terms key belongs to the family whose consent statement is approved", () => {
  assert.equal(TERMS_KEY, "np-tos-001");
  const c = currentAcceptanceConsent(TERMS_KEY, { nodeEnv: "production", appEnv: "production" });
  assert.equal(c.available, true);
});

test("the final np-tos-001 text has no draft markers or placeholders; the historical draft still has them", () => {
  assert.deepEqual(draftMarkers(termsBody()), []);
  const draft = readFileSync("docs/commercial/terms/np-tos-001-draft.md", "utf8");
  for (const m of ["RASCUNHO", "placeholder […]", "a completar", "serão definid(a)s"]) assert.ok(draftMarkers(draft).includes(m), m);
  assert.deepEqual(draftMarkers("A1. Partes. Prestador: Airton Alexandre, Lda., NIF 5000000000. Cliente: a organização identificada no resumo contratual."), []);
  // Answer 9.2 — mandatory elements present in the final text.
  const body = termsBody();
  for (const needle of ["NIF 5002819481", "comercial@ultimalinha.ao", "+244 944 111 842", "IVA incluído", "Lei n.º 22/11", "Comarca de Luanda", "não há direito de desistência", "ANEXO C"]) assert.ok(body.includes(needle), needle);
});
