import assert from "node:assert/strict";
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

test("the current Annex A + B text is still a draft: approval is refused until the legal gaps are closed", () => {
  const markers = draftMarkers(termsBody());
  for (const m of ["RASCUNHO", "placeholder […]", "a completar", "serão definid(a)s"]) assert.ok(markers.includes(m), m);
  assert.deepEqual(draftMarkers("A1. Partes\nPrestador: Airton Alexandre, Lda., NIF 5000000000. Cliente: a organização identificada no resumo contratual."), []);
});
