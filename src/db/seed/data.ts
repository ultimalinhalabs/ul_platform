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
  { key: "usage.read", description: "View an organization's recorded usage." },
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
  { key: "usage.write", description: "Record usage on behalf of the credential's application." },
  { key: "usage.read", description: "Read usage recorded for the credential's application." },
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
  NA_PISTA: ["event.publish", "usage.write", "usage.read", "catalog.read", "catalog.write", "customer.read"],
  MICHA_EXPRESS: ["event.publish", "usage.write", "usage.read", "payment.create", "payment.read"],
  FOI: ["event.publish", "usage.write", "usage.read", "catalog.read"],
  QUALE_A_DICA: ["event.publish", "usage.write", "usage.read", "catalog.read", "report.generate"],
  HOJE_TEM: ["event.publish", "usage.write", "usage.read", "report.generate"],
};

/**
 * Global registry of measurable resources (see db/schema/usage.ts). Generic
 * platform-shaped concepts, not real product telemetry — a product may
 * eventually need entirely different meters; these exist to prove the
 * registry + per-application allowlist actually works, exactly like
 * SERVICE_SCOPES above.
 */
export const METERS = [
  { key: "users", unit: "count", description: "Active users." },
  { key: "orders", unit: "count", description: "Orders processed." },
  { key: "transactions", unit: "count", description: "Transactions processed." },
  { key: "messages", unit: "count", description: "Messages sent." },
  { key: "storage_bytes", unit: "bytes", description: "Storage consumed." },
  { key: "api_requests", unit: "requests", description: "API requests made." },
] as const;

/**
 * Which METERS each Application may record/query usage against — the
 * metering equivalent of APPLICATION_SERVICE_SCOPES. Illustrative only
 * (see METERS above); real per-product meter selection is a product
 * integration decision, not something UL Platform prescribes.
 */
export const APPLICATION_METERS: Record<string, string[]> = {
  NA_PISTA: ["users", "orders", "storage_bytes", "api_requests"],
  MICHA_EXPRESS: ["transactions", "storage_bytes", "api_requests"],
  FOI: ["orders", "api_requests"],
  QUALE_A_DICA: ["messages", "api_requests"],
  HOJE_TEM: ["users", "api_requests"],
};

/**
 * Every real product application gets `production` + `staging` — just the
 * two labels CLAUDE.md's discovery prompt asks for at minimum (§4). A
 * local development environment is deliberately never registered here —
 * see db/schema/environments.ts. UL_CONSOLE is absent, same reasoning as
 * everywhere else it's excluded (an internal tool, not a product other
 * applications integrate with).
 */
export const APPLICATION_ENVIRONMENTS: Record<string, string[]> = {
  NA_PISTA: ["production", "staging"],
  MICHA_EXPRESS: ["production", "staging"],
  FOI: ["production", "staging"],
  QUALE_A_DICA: ["production", "staging"],
  HOJE_TEM: ["production", "staging"],
};

/**
 * Illustrative `staging`-only examples, using `.example` domains (RFC 2606
 * — reserved for documentation, guaranteed never to resolve) so nothing
 * here could be mistaken for real infrastructure. Deliberately no
 * `production` endpoint is seeded for any application — CLAUDE.md's
 * discovery prompt §27 is explicit: this platform does not invent
 * production URLs on a product's behalf. A real product supplies its own
 * production endpoint once it actually has one (see README "Who may
 * manage platform applications?").
 */
export const APPLICATION_ENDPOINTS: { applicationKey: string; environmentKey: string; type: "API"; baseUrl: string }[] = [
  { applicationKey: "NA_PISTA", environmentKey: "staging", type: "API", baseUrl: "https://staging.na-pista.example" },
  { applicationKey: "MICHA_EXPRESS", environmentKey: "staging", type: "API", baseUrl: "https://staging.micha-express.example" },
];

/**
 * Directional application-to-application integrations — the exact
 * examples CLAUDE.md's discovery prompt itself gives (§12). Platform-level
 * only, no `organizationId` (see db/schema/integrations.ts). Registering
 * these says only "these two applications may discover each other" — it
 * grants no capability by itself; the actual API call still needs the
 * target's own Service Scope check (see README "Integration ≠
 * Authorization").
 */
export const APPLICATION_INTEGRATIONS: { sourceApplicationKey: string; targetApplicationKey: string; description: string }[] = [
  {
    sourceApplicationKey: "QUALE_A_DICA",
    targetApplicationKey: "NA_PISTA",
    description: "Qualé a Dica?! reads Na Pista's catalog to answer product questions.",
  },
  {
    sourceApplicationKey: "NA_PISTA",
    targetApplicationKey: "MICHA_EXPRESS",
    description: "Na Pista creates payments through Micha Express.",
  },
  {
    sourceApplicationKey: "HOJE_TEM",
    targetApplicationKey: "QUALE_A_DICA",
    description: "Hoje Tem! requests recommendations from Qualé a Dica?!.",
  },
];

/**
 * Platform-authority roles — separate namespace from ROLES (organization
 * roles) on purpose, see db/schema/platformRoles.ts. v1 only ever needs one
 * tier; the catalog table exists so a second tier is a data change, not a
 * schema change, if the platform ever needs one.
 */
export const PLATFORM_ROLES = [
  {
    key: "PLATFORM_ADMIN",
    name: "Platform Admin",
    description: "Full administrative control of the platform's own global infrastructure (control plane).",
  },
] as const;

/**
 * Platform-authority permissions — separate namespace from PERMISSIONS on
 * purpose (see db/schema/platformPermissions.ts). Read access to the
 * Application/Environment/Endpoint/Integration registries is deliberately
 * NOT gated behind a platform permission here: those `GET` routes have
 * always been open to any authenticated user (non-sensitive platform
 * metadata, same posture as `/v1/roles`/`/v1/service-scopes`) and Phase 13
 * does not revoke that — only *mutating* them is new, and that is what
 * these permissions gate. `platform.platform_admin.read` is the one read
 * permission that does exist, because listing who holds platform authority
 * is itself sensitive (same reasoning `api_key.read` already established
 * for listing an organization's credentials).
 */
export const PLATFORM_PERMISSIONS = [
  { key: "platform.application.manage", description: "Create/update the global Application registry." },
  { key: "platform.environment.manage", description: "Create/update Application Environments." },
  { key: "platform.endpoint.manage", description: "Create/update Application Endpoints." },
  { key: "platform.integration.manage", description: "Create/update Application Integrations." },
  { key: "platform.platform_admin.read", description: "View the roster of platform administrators." },
  { key: "platform.platform_admin.manage", description: "Grant/revoke platform administrator access." },
] as const;

export const PLATFORM_ROLE_PERMISSIONS: Record<(typeof PLATFORM_ROLES)[number]["key"], string[]> = {
  PLATFORM_ADMIN: PLATFORM_PERMISSIONS.map((p) => p.key),
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
    "usage.read",
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
    "usage.read",
  ],
  MANAGER: [
    "organization.read",
    "membership.read",
    "application.read",
    "subscription.read",
    "entitlement.read",
    "usage.read",
  ],
  STAFF: ["organization.read", "membership.read"],
};
