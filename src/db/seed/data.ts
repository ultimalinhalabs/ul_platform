/** Static seed data — the source of truth for platform-defined catalogs. */

export const APPLICATIONS = [
  { key: "UL_CONSOLE", name: "UL Console", description: "Internal back-office console for Última Linha." },
  { key: "NA_PISTA", name: "Na Pista", description: "Operational management for businesses." },
  { key: "MICHA_EXPRESS", name: "Micha Express", description: "Payments, treasury and digital wallet." },
  { key: "FOI", name: "Foi", description: "Logistics, transport and delivery." },
  { key: "QUALE_A_DICA", name: "Qualé a Dica?!", description: "WhatsApp/conversational automation." },
  { key: "HOJE_TEM", name: "Hoje Tem", description: "Última Linha ecosystem application." },
] as const;

/**
 * `organization.create` is intentionally listed but never granted through
 * role_permissions: creating an organization happens before any membership
 * exists in it, so it can't be gated by an org-scoped role check. It's a
 * platform-level action (any authenticated user may create an organization
 * and becomes its first OWNER) enforced in the organizations service, not here.
 */
export const PERMISSIONS = [
  { key: "organization.read", description: "View an organization's details." },
  { key: "organization.create", description: "Create a new organization (platform-level, not org-scoped)." },
  { key: "organization.update", description: "Update an organization's details." },
  { key: "organization.delete", description: "Delete an organization." },
  { key: "membership.read", description: "View an organization's memberships." },
  { key: "membership.create", description: "Invite/add a member to an organization." },
  { key: "membership.update", description: "Change a member's role or status." },
  { key: "membership.remove", description: "Remove a member from an organization." },
  { key: "role.read", description: "View the platform role catalog." },
  { key: "role.assign", description: "Assign a role to a membership." },
  { key: "application.read", description: "View the registered applications." },
  { key: "subscription.read", description: "View an organization's subscriptions." },
  { key: "subscription.manage", description: "Create/change an organization's subscriptions." },
  { key: "entitlement.read", description: "View an organization's entitlements." },
  { key: "audit.read", description: "View an organization's audit log." },
] as const;

export const ROLES = [
  { key: "OWNER", name: "Owner", description: "Full administrative control of the organization." },
  { key: "ADMIN", name: "Admin", description: "Manages members and organization settings." },
  { key: "MANAGER", name: "Manager", description: "Operational visibility, no membership management." },
  { key: "STAFF", name: "Staff", description: "Read-only baseline access." },
] as const;

export const ROLE_PERMISSIONS: Record<(typeof ROLES)[number]["key"], string[]> = {
  OWNER: [
    "organization.read",
    "organization.update",
    "organization.delete",
    "membership.read",
    "membership.create",
    "membership.update",
    "membership.remove",
    "role.read",
    "role.assign",
    "application.read",
    "subscription.read",
    "subscription.manage",
    "entitlement.read",
    "audit.read",
  ],
  ADMIN: [
    "organization.read",
    "organization.update",
    "membership.read",
    "membership.create",
    "membership.update",
    "membership.remove",
    "role.read",
    "role.assign",
    "application.read",
    "subscription.read",
    "entitlement.read",
    "audit.read",
  ],
  MANAGER: [
    "organization.read",
    "membership.read",
    "application.read",
    "subscription.read",
    "entitlement.read",
  ],
  STAFF: ["organization.read", "membership.read"],
};
