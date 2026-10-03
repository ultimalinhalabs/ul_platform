/**
 * Fase 5 — test database guard. `config/env.ts` loads `.env` via
 * `dotenv/config`, so a local `npm test` used to run against whatever
 * DATABASE_URL `.env` held — the real Supabase project. Under the Node test
 * runner the connection must be a LOCAL database (CI already uses a
 * localhost Postgres service), unless `TEST_DATABASE_ALLOW_REMOTE=true`
 * explicitly opts into a dedicated remote test database.
 *
 * Pure: testable without opening a connection.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`[test-database-guard] ${message}`);
    this.name = "UnsafeTestDatabaseError";
  }
}

export function isTestRun(argv: string[] = process.argv, envVars: NodeJS.ProcessEnv = process.env): boolean {
  return envVars.NODE_TEST_CONTEXT != null || argv.includes("--test");
}

export function assertSafeTestDatabaseUrl(databaseUrl: string, allowRemote?: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new UnsafeTestDatabaseError("DATABASE_URL is not a valid connection URL.");
  }
  if (!LOCAL_HOSTS.has(host) && allowRemote !== "true") {
    throw new UnsafeTestDatabaseError(
      `refusing to run tests against a non-local database (${host}). Point DATABASE_URL at a local/disposable Postgres, ` +
        "or set TEST_DATABASE_ALLOW_REMOTE=true only for a remote database dedicated to tests.",
    );
  }
}
