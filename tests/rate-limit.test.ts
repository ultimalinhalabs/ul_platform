import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { rateLimit } from "../src/middleware/rateLimit.js";

// Minimal Express-shaped fakes — this middleware only touches req.auth/
// req.service/req.ip and res.setHeader/res.status/res.json, so a full
// supertest/HTTP harness would be pure overhead for testing its counting
// logic in isolation.
function fakeReq(overrides: Partial<{ ip: string; auth: { userId: string }; service: { apiKeyId: string } }> = {}) {
  return { ip: "127.0.0.1", ...overrides } as never;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  return {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  } as never;
}

test("rateLimit allows requests under the limit", () => {
  const limiter = rateLimit({ keyPrefix: `test.${randomUUID()}`, windowMs: 60_000, max: 3 });
  const req = fakeReq();

  for (let i = 0; i < 3; i++) {
    let nextCalled = false;
    limiter(req, fakeRes(), () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true, `request ${i + 1} should have been allowed`);
  }
});

test("rateLimit rejects the request once the limit is exceeded, with a 429 and Retry-After", () => {
  const limiter = rateLimit({ keyPrefix: `test.${randomUUID()}`, windowMs: 60_000, max: 2 });
  const req = fakeReq();

  limiter(req, fakeRes(), () => {});
  limiter(req, fakeRes(), () => {});

  let nextCalled = false;
  const res = fakeRes();
  limiter(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
  assert.equal((res as unknown as { body: { error: { code: string } } }).body.error.code, "RATE_LIMITED");
  assert.ok((res as unknown as { headers: Record<string, string> }).headers["Retry-After"]);
});

test("rateLimit tracks distinct callers (by auth/service identity) independently", () => {
  const limiter = rateLimit({ keyPrefix: `test.${randomUUID()}`, windowMs: 60_000, max: 1 });

  let userACalled = false;
  limiter(fakeReq({ auth: { userId: "user-a" } }), fakeRes(), () => {
    userACalled = true;
  });
  assert.equal(userACalled, true);

  // user-a is now at its limit, but a distinct identity must still get through.
  let userBCalled = false;
  limiter(fakeReq({ auth: { userId: "user-b" } }), fakeRes(), () => {
    userBCalled = true;
  });
  assert.equal(userBCalled, true);

  // user-a's second request in the same window is rejected.
  let userASecondCalled = false;
  const res = fakeRes();
  limiter(fakeReq({ auth: { userId: "user-a" } }), res, () => {
    userASecondCalled = true;
  });
  assert.equal(userASecondCalled, false);
  assert.equal((res as unknown as { statusCode: number }).statusCode, 429);
});

test("rateLimit prefers the authenticated identity over the raw IP, so a shared IP doesn't cross-limit different users", () => {
  const limiter = rateLimit({ keyPrefix: `test.${randomUUID()}`, windowMs: 60_000, max: 1 });
  const sharedIp = "10.0.0.1";

  let firstCalled = false;
  limiter(fakeReq({ ip: sharedIp, auth: { userId: "user-a" } }), fakeRes(), () => {
    firstCalled = true;
  });
  assert.equal(firstCalled, true);

  let secondCalled = false;
  limiter(fakeReq({ ip: sharedIp, auth: { userId: "user-b" } }), fakeRes(), () => {
    secondCalled = true;
  });
  assert.equal(secondCalled, true, "a different authenticated user behind the same IP must not inherit user-a's limit");
});
