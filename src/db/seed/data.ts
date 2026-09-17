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
  { key: "api_key.manage", description: "Create/revoke an organization's API keys." },
  { key: "api_key.read", description: "View an organization's API key metadata (never secrets)." },
  { key: "webhook.manage", description: "Create/revoke an organization's webhook endpoints." },
  { key: "webhook.read", description: "View an organization's webhook endpoints (never secrets)." },
] as const;

/**
 * Global registry of machine-actionable capabilities a service credential
 * may be granted — the service-identity equivalent of `PERMISSIONS` above.
 * These are examples of the generic vocabulary CLAUDE.md asks for, not a
 * product-specific catalog: `event.publish` is the one platform-owned
 * capability (any application may publish an event about itself), the
 * rest are illustrative product-shaped actions used to prove the
 * application-scoping model actually restricts something.
 */
export const SERVICE_SCOPES = [
  { key: "event.publish", description: "Publish a platform event on behalf of the credential's application." },
  { key: "catalog.read", description: "Read catalog data." },
  { key: "catalog.write", description: "Create/update catalog data." },
  { key: "customer.read", description: "Read customer data." },
  { key: "payment.create", description: "Create a payment." },
  { key: "payment.read", description: "Read payment data." },
  { key: "report.generate", description: "Generate a report." },
] as const;

/**
 * Which SERVICE_SCOPES each Application's credentials may request — the
 * allowlist that stops a QUALE_A_DICA credential from ever being granted a
 * MICHA_EXPRESS-only scope (see modules/serviceScopes/service.ts).
 * `event.publish` is granted to every application with real service
 * integrations: publishing "something happened about my own org" is a
 * baseline platform capability, not a premium/product-specific one.
 * UL_CONSOLE is deliberately absent — it's an internal tool organizations
 * never subscribe to or issue integration credentials for.
 */
export const APPLICATION_SERVICE_SCOPES: Record<string, string[]> = {
  NA_PISTA: ["event.publish", "catalog.read", "catalog.write", "customer.read"],
  MICHA_EXPRESS: ["event.publish", "payment.create", "payment.read"],
  FOI: ["event.publish", "catalog.read"],
  QUALE_A_DICA: ["event.publish", "catalog.read", "report.generate"],
  HOJE_TEM: ["event.publish", "report.generate"],
};

export const ROLES = [
  { key: "OWNER", name: "Owner", description: "Full administrative control of the organization." },
  { key: "ADMIN", name: "Admin", description: "Manages members and organization settings." },
  { key: "MANAGER", name: "Manager", description: "Operational visibility, no membership management." },
  { key: "STAFF", name: "Staff", description: "Read-only baseline access." },
] as const;

/**
 * Deliberately minimal — just enough to prove Application → Plan →
 * Entitlement works, not a real commercial catalog. `key` is only
 * unique per application, so "BUSINESS" is intentionally reused across
 * several applications here to exercise that scoping. UL_CONSOLE has no
 * plans (an internal tool, not something Organizations subscribe to) —
 * also intentional, an application with zero plans is a valid state.
 */
export const PLANS = [
  { applicationKey: "NA_PISTA", key: "STARTER", name: "Starter", description: "Entry-level Na Pista plan." },
  { applicationKey: "NA_PISTA", key: "BUSINESS", name: "Business", description: "Full-featured Na Pista plan." },
  { applicationKey: "MICHA_EXPRESS", key: "BASIC", name: "Basic", description: "Entry-level Micha Express plan." },
  { applicationKey: "MICHA_EXPRESS", key: "BUSINESS", name: "Business", description: "Full-featured Micha Express plan." },
  { applicationKey: "FOI", key: "BUSINESS", name: "Business", description: "Foi's standard business plan." },
  { applicationKey: "QUALE_A_DICA", key: "BUSINESS", name: "Business", description: "Qualé a Dica?!'s standard business plan." },
  { applicationKey: "HOJE_TEM", key: "COMMUNITY", name: "Community", description: "Hoje Tem!'s baseline plan." },
] as const;

/**
 * Mixed value types (boolean, integer) deliberately, to prove the jsonb
 * `value` column represents both without a separate type column. Keys
 * are generic commercial concepts (`*.max`, `*.enabled`), not product
 * internals — see planEntitlements.ts for why there's no product-aware
 * validation of these keys.
 */
export const PLAN_ENTITLEMENTS = [
  { applicationKey: "NA_PISTA", planKey: "STARTER", key: "catalog.enabled", value: true },
  { applicationKey: "NA_PISTA", planKey: "STARTER", key: "products.max", value: 100 },
  { applicationKey: "NA_PISTA", planKey: "BUSINESS", key: "catalog.enabled", value: true },
  { applicationKey: "NA_PISTA", planKey: "BUSINESS", key: "products.max", value: 1000 },
  { applicationKey: "NA_PISTA", planKey: "BUSINESS", key: "advanced_reports.enabled", value: true },
  { applicationKey: "MICHA_EXPRESS", planKey: "BASIC", key: "transactions.max", value: 1000 },
  { applicationKey: "MICHA_EXPRESS", planKey: "BUSINESS", key: "transactions.max", value: 100000 },
  { applicationKey: "MICHA_EXPRESS", planKey: "BUSINESS", key: "priority_support.enabled", value: true },
  { applicationKey: "FOI", planKey: "BUSINESS", key: "deliveries.max", value: 5000 },
  { applicationKey: "QUALE_A_DICA", planKey: "BUSINESS", key: "conversations.max", value: 10000 },
  { applicationKey: "HOJE_TEM", planKey: "COMMUNITY", key: "members.max", value: 50 },
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
    "api_key.manage",
    "api_key.read",
    "webhook.manage",
    "webhook.read",
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
    "api_key.read",
    "webhook.read",
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
