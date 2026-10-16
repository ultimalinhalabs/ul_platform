/**
 * Dev-only fixture/validation scripts write real data: Supabase Auth users
 * (Admin API, service-role key) and mass deletes by name pattern. They read
 * whatever `.env` holds — which once pointed at the production Auth project.
 * Every such script calls this first and refuses to run unless each target
 * it uses is a loopback host and nothing says "production".
 *
 * Pure: testable without opening a connection (tests/local-only-guard.test.ts).
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class NonLocalTargetError extends Error {
  constructor(message: string) {
    super(`[local-only-guard] ${message}`);
    this.name = "NonLocalTargetError";
  }
}

function assertLoopback(name: string, value: string | undefined) {
  let host: string;
  try {
    host = new URL(value ?? "").hostname.toLowerCase();
  } catch {
    throw new NonLocalTargetError(`${name} is not a valid URL — refusing.`);
  }
  if (!LOCAL_HOSTS.has(host)) throw new NonLocalTargetError(`${name} points at a non-local host (${host}) — refusing.`);
}

export function assertLocalOnlyTargets(
  targets: { supabase?: boolean; database?: boolean },
  envVars: NodeJS.ProcessEnv = process.env,
): void {
  for (const key of ["NODE_ENV", "APP_ENV"] as const) {
    if (["production", "staging"].includes(envVars[key] ?? "")) {
      throw new NonLocalTargetError(`${key}=${envVars[key]} — dev-only script refusing to run.`);
    }
  }
  if (targets.supabase) assertLoopback("SUPABASE_URL", envVars.SUPABASE_URL);
  if (targets.database) assertLoopback("DATABASE_URL", envVars.DATABASE_URL);
}
