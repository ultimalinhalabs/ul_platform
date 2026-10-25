import { and, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ValidationError } from "./errors.js";

/**
 * Keyset cursor = (timestamp, id). The timestamp is carried at FULL Postgres precision (microseconds,
 * rendered by Postgres via `preciseAt`) and compared in SQL — never through a JS Date, which only holds
 * milliseconds: two rows in the same millisecond would otherwise make the next page skip one.
 * Older millisecond cursors (`…sss.mmmZ`) are still accepted.
 */
export type Cursor = { at: string; id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** A column's value as a UTC ISO string with microseconds, produced by Postgres. */
export const preciseAt = (column: SQL.Aliased | PgColumn) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** "Strictly after the cursor" for ORDER BY (column DESC, id DESC), compared at full precision. */
export const afterCursor = (column: PgColumn, idColumn: PgColumn, c: Cursor) =>
  or(sql`${column} < ${c.at}::timestamptz`, and(sql`${column} = ${c.at}::timestamptz`, lt(idColumn, c.id)))!;

export function encodeCursor(at: string, id: string) {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}
export function decodeCursor(raw: string): Cursor {
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (!at || !ISO_UTC.test(at) || Number.isNaN(new Date(at).getTime()) || !id || !UUID.test(id)) throw new ValidationError("Invalid cursor");
  return { at, id };
}
export function page<T extends { cursorAt: string }>(rows: T[], limit: number, idOf: (row: T) => string) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.cursorAt, idOf(last)) : null };
}
/** Removes the internal cursor column before a row leaves the module. */
export function withoutCursor<T extends { cursorAt: string }>(row: T): Omit<T, "cursorAt"> {
  const { cursorAt, ...rest } = row;
  void cursorAt;
  return rest;
}
/**
 * Runs the given (lazy) Drizzle queries ONE AT A TIME and returns their results in order — same shape as
 * Promise.all. Never Promise.all database reads here: production reaches Postgres through the Supabase
 * transaction pooler with a small client pool (max 5, db/index.ts), and several queries in flight at once
 * through that pooler can stall (GET /platform/commercial/summary hit the 300 s Vercel timeout with 8
 * parallel counts; reproduced locally with Supavisor in transaction mode: old code hung, this returns).
 */
export async function inSequence<T extends readonly unknown[]>(queries: readonly [...{ [K in keyof T]: PromiseLike<T[K]> }]): Promise<T> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as unknown as T;
}

