import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { app } from "../src/app.js";
import { env } from "../src/config/env.js";

/**
 * Regression for UL Console's "Não foi possível contactar a API" on Aplicações/Integrações/Discovery
 * (2026-10-20): a browser-cached `GET /v1/applications` (stored for another same-site origin) was
 * revalidated with If-None-Match, the API answered 304, Vercel dropped the CORS headers from the 304 and
 * Chrome failed the fetch. API responses must never be cacheable nor conditional.
 */
const server = app.listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const origin = env.PLATFORM_ALLOWED_ORIGINS[0]!;

after(() => {
  server.close();
});

test("API responses carry Cache-Control: no-store and no ETag", async () => {
  for (const path of ["/health", "/applications"]) {
    const res = await fetch(`${base()}${path}`, { headers: { Origin: origin } });
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("etag"), null, path);
    assert.equal(res.headers.get("access-control-allow-origin"), origin, path);
  }
});

test("a conditional request is answered in full (never 304), with the CORS headers of the caller's origin", async () => {
  const first = await fetch(`${base()}/health`, { headers: { Origin: origin } });
  await first.text();
  const res = await fetch(`${base()}/health`, { headers: { Origin: origin, "If-None-Match": first.headers.get("etag") ?? 'W/"anything"' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  await res.text();
});

test("CORS is unchanged: an origin outside the allow-list still gets no Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${base()}/health`, { headers: { Origin: "https://not-allowed.invalid" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  await res.text();
});
