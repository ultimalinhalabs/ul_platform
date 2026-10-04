import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";
import { assertSafeTestDatabaseUrl, isTestRun } from "./testDatabaseGuard.js";

// Fase 5 — a test run never connects to a non-local database (see testDatabaseGuard.ts).
if (isTestRun()) assertSafeTestDatabaseUrl(env.DATABASE_URL, process.env.TEST_DATABASE_ALLOW_REMOTE);

// Small pool + idle_timeout: this app doesn't need many concurrent
// connections, and Supabase's pooler has a low connection ceiling shared
// across everything hitting the project. Fase 5.2: `prepare: false` because
// the API on Vercel connects through the Supavisor TRANSACTION pooler (port
// 6543), which cannot keep named prepared statements across transactions;
// it is equally correct on the session pooler / a direct connection (worker).
export const queryClient = postgres(env.DATABASE_URL, { max: 5, idle_timeout: 20, prepare: false });

export const db = drizzle(queryClient, { schema });
