import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";
import { assertSafeTestDatabaseUrl, isTestRun } from "./testDatabaseGuard.js";

// Fase 5 — a test run never connects to a non-local database (see testDatabaseGuard.ts).
if (isTestRun()) assertSafeTestDatabaseUrl(env.DATABASE_URL, process.env.TEST_DATABASE_ALLOW_REMOTE);

// Small pool + idle_timeout: this app doesn't need many concurrent
// connections, and Supabase's pooler (pgbouncer session mode) has a low
// connection ceiling shared across everything hitting the project.
export const queryClient = postgres(env.DATABASE_URL, { max: 5, idle_timeout: 20 });

export const db = drizzle(queryClient, { schema });
