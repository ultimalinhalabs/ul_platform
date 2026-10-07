import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../src/config/env.js";
import { assertSafeTestDatabaseUrl } from "../src/db/testDatabaseGuard.js";

/**
 * Block 1A — migrations 0015–0019 applied (a) from zero and (b) in sequence on
 * top of a 0014 database whose default privileges mimic Supabase's
 * (anon/authenticated get ALL on new tables) — the explicit REVOKEs must
 * still leave zero grants. Both databases must end with the same schema, and
 * re-running the migrator must be a no-op. Uses temporary databases on the
 * SAME local server as DATABASE_URL (guarded: never a remote host), dropped
 * at the end. No network beyond that local server.
 */

assertSafeTestDatabaseUrl(env.DATABASE_URL, process.env.TEST_DATABASE_ALLOW_REMOTE);
if (process.env.TEST_DATABASE_ALLOW_REMOTE === "true") throw new Error("commercial migration tests create/drop databases: local server only");

const COMMERCIAL_TABLES = [
  "commercial_events",
  "commercial_terms_templates",
  "proposals",
  "proposal_versions",
  "proposal_options",
  "proposal_items",
  "proposal_access_links",
  "proposal_acceptances",
  "contracts",
  "contract_versions",
  "contract_items",
  "entitlement_grants",
];

const suffix = randomBytes(4).toString("hex");
const DB_ZERO = `ul_b1a_zero_${suffix}`;
const DB_SEQ = `ul_b1a_seq_${suffix}`;
const urlFor = (database: string) => {
  const u = new URL(env.DATABASE_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const admin = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
const tempDirs: string[] = [];

async function migrateTo(database: string, folder: string) {
  const sql = postgres(urlFor(database), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end();
  }
}

/** A copy of drizzle/migrations whose journal stops at `lastIdx` — how a database that is "at 0014" is produced. */
function folderUpTo(lastIdx: number) {
  const dir = mkdtempSync(join(tmpdir(), "ul-b1a-"));
  tempDirs.push(dir);
  cpSync("drizzle/migrations", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/** Everything that defines the public schema, normalized for comparison. */
async function schemaSignature(database: string) {
  const sql = postgres(urlFor(database), { max: 1, onnotice: () => {} });
  try {
    const parts = await Promise.all([
      sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by 1, 2`,
      sql`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`,
      sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`,
      sql`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal order by 1, 2`,
      sql`select proname, pg_get_functiondef(p.oid) as def from pg_proc p where pronamespace = 'public'::regnamespace order by 1`,
      sql`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`,
      sql`select sequencename from pg_sequences where schemaname = 'public' order by 1`,
    ]);
    return JSON.stringify(parts);
  } finally {
    await sql.end();
  }
}

before(async () => {
  for (const r of ["anon", "authenticated"]) {
    await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  }
  await admin.unsafe(`create database ${DB_ZERO}`);
  await admin.unsafe(`create database ${DB_SEQ}`);
});

after(async () => {
  await admin.unsafe(`drop database if exists ${DB_ZERO} with (force)`);
  await admin.unsafe(`drop database if exists ${DB_SEQ} with (force)`);
  await admin.end();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("the journal continues at 0015, keeps 0015–0019 unchanged and only appends after them (D2-B: 0020)", () => {
  const journal = JSON.parse(readFileSync("drizzle/migrations/meta/_journal.json", "utf8")).entries as Array<{ idx: number; tag: string }>;
  assert.deepEqual(
    journal.slice(15, 20).map((e) => e.tag),
    ["0015_commercial_permissions", "0016_commercial_events_and_terms", "0017_proposals", "0018_acceptances_and_contracts", "0019_entitlement_grants"],
  );
  assert.equal(journal[14]!.tag, "0014_organization_application_access");
  assert.deepEqual(journal.slice(20).map((e) => e.tag), ["0020_managed_credential_provisioning"]);
});

test("from zero and in sequence (0014 → Supabase-like default grants → 0019) produce the same schema; zero anon/authenticated grants", async () => {
  await migrateTo(DB_ZERO, "drizzle/migrations");

  await migrateTo(DB_SEQ, folderUpTo(14));
  const seq = postgres(urlFor(DB_SEQ), { max: 1, onnotice: () => {} });
  try {
    // What Supabase does for objects created in public: give the Data API roles everything.
    await seq.unsafe("alter default privileges in schema public grant all on tables to anon, authenticated");
    await seq.unsafe("alter default privileges in schema public grant all on sequences to anon, authenticated");
  } finally {
    await seq.end();
  }
  await migrateTo(DB_SEQ, "drizzle/migrations");

  assert.equal(await schemaSignature(DB_SEQ), await schemaSignature(DB_ZERO), "schema must not depend on the migration path");

  const check = postgres(urlFor(DB_SEQ), { max: 1, onnotice: () => {} });
  try {
    const grants = await check`
      select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any(${COMMERCIAL_TABLES})
        and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`;
    assert.deepEqual([...grants], [], "explicit REVOKEs must leave the commercial tables closed even under Supabase default privileges");
    const seqGrants = await check`
      select relname from pg_class where relkind = 'S' and relname like 'commercial\_%' and (has_sequence_privilege('anon', oid, 'USAGE') or has_sequence_privilege('authenticated', oid, 'USAGE'))`;
    assert.deepEqual([...seqGrants], []);
    const rls = await check`select relname from pg_class where relnamespace = 'public'::regnamespace and relname = any(${COMMERCIAL_TABLES}) and not relrowsecurity`;
    assert.deepEqual([...rls], []);
    assert.equal((await check`select 1 from pg_policies where tablename = any(${COMMERCIAL_TABLES})`).length, 0);
  } finally {
    await check.end();
  }
});

test("re-running the migrator is a no-op (replay/idempotency)", async () => {
  const sql = postgres(urlFor(DB_ZERO), { max: 1, onnotice: () => {} });
  try {
    const [before] = await sql`select count(*)::int as n, max(created_at)::bigint as last from drizzle.__drizzle_migrations`;
    const signatureBefore = await schemaSignature(DB_ZERO);
    await migrateTo(DB_ZERO, "drizzle/migrations");
    const [after] = await sql`select count(*)::int as n, max(created_at)::bigint as last from drizzle.__drizzle_migrations`;
    assert.equal(after!.n, before!.n);
    assert.equal(String(after!.last), String(before!.last));
    assert.equal(await schemaSignature(DB_ZERO), signatureBefore);
    assert.equal(before!.n, 21);
  } finally {
    await sql.end();
  }
});
