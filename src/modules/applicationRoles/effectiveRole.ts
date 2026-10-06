/**
 * Fase 6 — PROVISIONAL fallback from the organization-wide role to an
 * application role, used only when a membership has no explicit row in
 * `membership_application_roles` for that application. Documented in
 * docs/PHASE-6-IDENTITY-ORGANIZATION-AUTHORITY.md; expected to shrink as
 * organizations assign explicit application roles.
 *
 * Applications without an entry here have no application-role concept yet:
 * their effective application role is `null` (the organization role is
 * still available to them, unchanged).
 */
export const ORGANIZATION_ROLE_FALLBACK: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  QUALE_A_DICA: { OWNER: "OWNER", ADMIN: "ADMIN", MANAGER: "AGENT", STAFF: "AGENT" },
  NA_PISTA: { OWNER: "OWNER", ADMIN: "ADMIN", MANAGER: "MANAGER", STAFF: "STAFF" },
};

export type EffectiveApplicationRole = { roleKey: string; source: "explicit" | "fallback" };

/** Pure: explicit application role wins; otherwise the documented fallback; otherwise none. */
export function resolveEffectiveApplicationRole(input: {
  applicationKey: string;
  organizationRoleKey: string;
  explicitRoleKey?: string | null;
}): EffectiveApplicationRole | null {
  if (input.explicitRoleKey) return { roleKey: input.explicitRoleKey, source: "explicit" };
  const mapped = ORGANIZATION_ROLE_FALLBACK[input.applicationKey]?.[input.organizationRoleKey];
  return mapped ? { roleKey: mapped, source: "fallback" } : null;
}
