import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiKeyScopes, applicationServiceScopes, applications, serviceScopes } from "../../db/schema/index.js";
import { ForbiddenError, ValidationError } from "../../shared/errors.js";
import { getApplicationByKey } from "../applications/service.js";

/** The full platform scope registry — read-only, seeded (see db/seed/data.ts). */
export async function listServiceScopes() {
  return db
    .select({ key: serviceScopes.key, description: serviceScopes.description })
    .from(serviceScopes)
    .orderBy(serviceScopes.key);
}

/** The subset of the registry a given Application's credentials may request. */
export async function listApplicationServiceScopes(applicationKey: string) {
  const application = await getApplicationByKey(applicationKey);

  const rows = await db
    .select({ key: serviceScopes.key, description: serviceScopes.description })
    .from(applicationServiceScopes)
    .innerJoin(serviceScopes, eq(serviceScopes.id, applicationServiceScopes.serviceScopeId))
    .innerJoin(applications, eq(applications.id, applicationServiceScopes.applicationId))
    .where(eq(applications.key, applicationKey))
    .orderBy(serviceScopes.key);

  return { application: { key: application.key, name: application.name }, scopes: rows };
}

/**
 * Validates a requested scope list against both the global registry and the
 * requesting Application's allowlist, then returns the resolved
 * `{ id, key }` rows to persist as granted scopes. Never trusts the caller's
 * strings past this point — CLAUDE.md's service-scope prompt is explicit
 * that "scope = admin.everything" must not be accepted merely because it's
 * a string.
 *
 * Two distinct rejection shapes, deliberately not collapsed into one:
 *  - a scope key that doesn't exist anywhere in the registry is a
 *    malformed request (`ValidationError`, 400) — the caller typed
 *    something that was never a scope.
 *  - a scope key that exists but isn't in this Application's allowlist is
 *    an authorization boundary (`ForbiddenError`, 403) — the caller asked
 *    for a real capability that this Application may never hold.
 */
export async function validateRequestedScopes(
  applicationId: string,
  applicationKey: string,
  requestedScopeKeys: string[],
): Promise<{ id: string; key: string }[]> {
  if (requestedScopeKeys.length === 0) return [];

  const uniqueKeys = [...new Set(requestedScopeKeys)];

  const registryRows = await db
    .select({ id: serviceScopes.id, key: serviceScopes.key })
    .from(serviceScopes)
    .where(inArray(serviceScopes.key, uniqueKeys));

  const registryByKey = new Map(registryRows.map((r) => [r.key, r]));
  const unknown = uniqueKeys.filter((k) => !registryByKey.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown service scope(s): ${unknown.join(", ")}`);
  }

  const allowedRows = await db
    .select({ key: serviceScopes.key })
    .from(applicationServiceScopes)
    .innerJoin(serviceScopes, eq(serviceScopes.id, applicationServiceScopes.serviceScopeId))
    .where(
      and(eq(applicationServiceScopes.applicationId, applicationId), inArray(serviceScopes.key, uniqueKeys)),
    );

  const allowedKeys = new Set(allowedRows.map((r) => r.key));
  const disallowed = uniqueKeys.filter((k) => !allowedKeys.has(k));
  if (disallowed.length > 0) {
    throw new ForbiddenError(
      `Application "${applicationKey}" is not authorized for scope(s): ${disallowed.join(", ")}`,
    );
  }

  return uniqueKeys.map((k) => registryByKey.get(k)!);
}

/** Which scopes were actually granted to a given API key — never the requested list, only what was persisted. */
export async function getGrantedScopeKeys(apiKeyId: string): Promise<string[]> {
  const rows = await db
    .select({ key: serviceScopes.key })
    .from(apiKeyScopes)
    .innerJoin(serviceScopes, eq(serviceScopes.id, apiKeyScopes.serviceScopeId))
    .where(eq(apiKeyScopes.apiKeyId, apiKeyId))
    .orderBy(serviceScopes.key);
  return rows.map((r) => r.key);
}

/** Does this credential hold this exact scope? The single check `requireServiceScope` middleware delegates to. */
export async function serviceCredentialHasScope(apiKeyId: string, scopeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeyScopes.serviceScopeId })
    .from(apiKeyScopes)
    .innerJoin(serviceScopes, eq(serviceScopes.id, apiKeyScopes.serviceScopeId))
    .where(and(eq(apiKeyScopes.apiKeyId, apiKeyId), eq(serviceScopes.key, scopeKey)))
    .limit(1);
  return Boolean(row);
}
