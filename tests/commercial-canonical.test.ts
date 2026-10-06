import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, canonicalSha256, sha256Hex } from "../src/modules/commercial/canonicalJson.js";
import { lineTotalMinor, minorAmountSchema, sumMinor } from "../src/modules/commercial/money.js";
import { buildVersionSnapshot, type SnapshotInput } from "../src/modules/commercial/proposals.service.js";
import { generateLinkToken, hashLinkToken, LINK_TOKEN_PATTERN } from "../src/modules/commercial/tokens.js";

/** Block 1B — pure helpers: canonical JSON/hash, link tokens, money. No database, no network. */

test("canonical JSON: key order is irrelevant, array order is significant, output is compact", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, 1], c: "x" } }), '{"a":{"c":"x","d":[3,1]},"b":1}');
  assert.equal(canonicalize({ a: { c: "x", d: [3, 1] }, b: 1 }), canonicalize({ b: 1, a: { d: [3, 1], c: "x" } }));
  assert.notEqual(canonicalize({ a: [1, 3] }), canonicalize({ a: [3, 1] }));
  assert.equal(canonicalize({ s: 'aspas " e \\ e ç' }), '{"s":"aspas \\" e \\\\ e ç"}');
  assert.equal(canonicalize([null, true, false, 0, -5]), "[null,true,false,0,-5]");
});

test("canonical JSON rejects what cannot be represented exactly (floats, bigint, undefined, non-plain objects)", () => {
  for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, 10n, undefined, () => 1, new Date(), new Map()]) {
    assert.throws(() => canonicalize({ v: bad }), TypeError);
  }
});

test("canonical SHA-256 is deterministic and sensitive to any content change", () => {
  const a = { options: [{ name: "Essencial", totalMinor: "20000000" }], currency: "AOA" };
  const reordered = { currency: "AOA", options: [{ totalMinor: "20000000", name: "Essencial" }] };
  assert.equal(canonicalSha256(a), canonicalSha256(reordered));
  assert.match(canonicalSha256(a), /^[0-9a-f]{64}$/);
  assert.notEqual(canonicalSha256(a), canonicalSha256({ ...a, options: [{ name: "Essencial", totalMinor: "20000001" }] }));
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("version snapshot: same content in a different row order gives the same hash; a price change gives another", () => {
  const option = (id: string, name: string, total: bigint, sort: number) => ({
    option: { id, versionId: "v", sort, name, summary: null, isRecommended: sort === 0, totalMinor: total, createdAt: new Date(0), updatedAt: new Date(0) },
    items: [
      {
        item: {
          id: `${id}-i`,
          optionId: id,
          sort: 0,
          kind: "service" as const,
          title: "Configuração",
          description: null,
          applicationId: null,
          planId: null,
          quantity: 2,
          unitPriceMinor: total / 2n,
          lineTotalMinor: total,
          billingPeriod: "one_time" as const,
          durationMonths: null,
          entitlementSpec: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        applicationKey: null,
        applicationName: null,
        planKey: null,
        planName: null,
      },
    ],
  });
  const base: SnapshotInput = {
    proposal: { number: "UL-P-2026-000001", prospectCompanyName: "Empresa", prospectTaxId: null, recipientName: "Ana", recipientEmail: "ana@example.invalid" },
    version: { versionNo: 1, currency: "AOA", validUntil: new Date("2026-12-31T00:00:00Z"), summary: "Resumo" },
    terms: { key: "termos", version: 1, title: "Termos", body: "corpo", bodySha256: sha256Hex("corpo") },
    options: [option("o1", "Essencial", 20_000_000n, 0), option("o2", "Advanced", 35_000_000n, 1)],
  };
  const h1 = canonicalSha256(buildVersionSnapshot(base));
  assert.equal(h1, canonicalSha256(buildVersionSnapshot({ ...base, proposal: { ...base.proposal } })));
  assert.notEqual(h1, canonicalSha256(buildVersionSnapshot({ ...base, options: [option("o1", "Essencial", 20_000_002n, 0), base.options[1]!] })));
  assert.notEqual(h1, canonicalSha256(buildVersionSnapshot({ ...base, terms: { ...base.terms, body: "outro", bodySha256: sha256Hex("outro") } })));
  const snapshot = buildVersionSnapshot(base);
  assert.equal(snapshot.options[0]!.totalMinor, "20000000", "money is serialized as decimal strings");
  assert.equal("notes" in snapshot.version, false, "internal notes are not part of the presented content");
});

test("link tokens: 43-char base64url from 32 random bytes, unique, stored only as SHA-256", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { token, tokenSha256 } = generateLinkToken();
    assert.match(token, LINK_TOKEN_PATTERN);
    assert.equal(tokenSha256, hashLinkToken(token));
    assert.match(tokenSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(tokenSha256, token);
    assert.equal(seen.has(token), false);
    seen.add(token);
  }
});

test("money: minor units only (AOA: 1 Kz = 100), exact bigint arithmetic, invalid amounts rejected", () => {
  assert.equal(minorAmountSchema.parse("10000000"), 10_000_000n); // 100 000 Kz
  assert.equal(minorAmountSchema.parse(0), 0n);
  for (const bad of ["-1", "1.5", "1e6", "", " 1", "0x10", -1, 1.5, "99999999999999999999"]) {
    assert.equal(minorAmountSchema.safeParse(bad).success, false, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(lineTotalMinor(3, 25_000_000_000_000n), 75_000_000_000_000n);
  assert.equal(sumMinor([1n, 2n, 3n]), 6n);
  assert.throws(() => lineTotalMinor(1_000_000, 9_223_372_036_854_775_807n));
});
