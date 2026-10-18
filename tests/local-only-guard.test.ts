import assert from "node:assert/strict";
import test from "node:test";
import { NonLocalTargetError, assertLocalOnlyTargets } from "../scripts/localOnlyGuard.js";

const LOCAL = { SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgres://user:pw@localhost:54329/db" };

test("dev scripts run against loopback Supabase and database", () => {
  assert.doesNotThrow(() => assertLocalOnlyTargets({ supabase: true, database: true }, { ...LOCAL, NODE_ENV: "development" }));
  assert.doesNotThrow(() => assertLocalOnlyTargets({ database: true }, { DATABASE_URL: "postgres://[::1]:5432/db" }));
});

test("a remote Supabase project is refused (the production Auth project included)", () => {
  assert.throws(
    () => assertLocalOnlyTargets({ supabase: true, database: true }, { ...LOCAL, SUPABASE_URL: "https://qajlwcbvssikljoqmbii.supabase.co" }),
    NonLocalTargetError,
  );
});

test("a remote database (pooler) is refused", () => {
  assert.throws(
    () => assertLocalOnlyTargets({ database: true }, { DATABASE_URL: "postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com:5432/postgres" }),
    NonLocalTargetError,
  );
});

test("missing or invalid URLs and production/staging environments are refused", () => {
  assert.throws(() => assertLocalOnlyTargets({ supabase: true }, {}), NonLocalTargetError);
  assert.throws(() => assertLocalOnlyTargets({ database: true }, { DATABASE_URL: "not a url" }), NonLocalTargetError);
  assert.throws(() => assertLocalOnlyTargets({ database: true }, { ...LOCAL, NODE_ENV: "production" }), NonLocalTargetError);
  assert.throws(() => assertLocalOnlyTargets({ database: true }, { ...LOCAL, APP_ENV: "staging" }), NonLocalTargetError);
});

test("only the targets a script declares are checked", () => {
  assert.doesNotThrow(() => assertLocalOnlyTargets({ database: true }, { ...LOCAL, SUPABASE_URL: "https://ci-fixture-project.supabase.co" }));
});
