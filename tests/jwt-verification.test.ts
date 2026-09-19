import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { env } from "../src/config/env.js";
import { EXPECTED_ISSUER, InvalidTokenError, verifySupabaseAccessToken } from "../src/integrations/supabase/jwt.js";

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

function baseToken() {
  return new SignJWT({ email: "test@test.ul-platform.invalid", aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m");
}

test("verifySupabaseAccessToken accepts a well-formed HS256 token", async () => {
  const token = await baseToken().sign(secret);
  const claims = await verifySupabaseAccessToken(token);
  assert.equal(claims.aud, "authenticated");
});

test("verifySupabaseAccessToken rejects a tampered signature", async () => {
  const token = await baseToken().sign(secret);
  const tampered = token.slice(0, -4) + "abcd";
  await assert.rejects(() => verifySupabaseAccessToken(tampered), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects an expired token", async () => {
  const token = await new SignJWT({ email: "test@test.ul-platform.invalid", aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
    .sign(secret);
  await assert.rejects(() => verifySupabaseAccessToken(token), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects the wrong issuer", async () => {
  const token = await new SignJWT({ email: "test@test.ul-platform.invalid", aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuedAt()
    .setIssuer("https://attacker-controlled.example/auth/v1")
    .setExpirationTime("10m")
    .sign(secret);
  await assert.rejects(() => verifySupabaseAccessToken(token), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects the wrong audience", async () => {
  const token = await new SignJWT({ email: "test@test.ul-platform.invalid", aud: "some-other-audience", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(randomUUID())
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
  await assert.rejects(() => verifySupabaseAccessToken(token), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects a token signed with the wrong secret", async () => {
  const wrongSecret = new TextEncoder().encode("a completely different 32+ byte secret value used only here");
  const token = await baseToken().sign(wrongSecret);
  await assert.rejects(() => verifySupabaseAccessToken(token), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects a malformed token", async () => {
  await assert.rejects(() => verifySupabaseAccessToken("not-a-real-token"), InvalidTokenError);
  await assert.rejects(() => verifySupabaseAccessToken(""), InvalidTokenError);
});

test("verifySupabaseAccessToken rejects a token missing a required claim (sub)", async () => {
  const token = await new SignJWT({ email: "test@test.ul-platform.invalid", aud: "authenticated", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(EXPECTED_ISSUER)
    .setExpirationTime("10m")
    .sign(secret);
  await assert.rejects(() => verifySupabaseAccessToken(token), InvalidTokenError);
});
