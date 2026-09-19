# UL Platform

Shared infrastructure layer for the Última Linha ecosystem: identity, organizations,
memberships, roles/permissions, applications, plans/subscriptions, entitlements,
customers and audit. It is not a container for product business logic — see
`../docs/UL_PLATFORM_CONTEXT_V1.md` and this repo's own architectural rules.

## Stack

Node.js, TypeScript, Express, PostgreSQL (Drizzle ORM), Supabase Auth, Zod.

> **DATABASE_URL / Supabase project must be dedicated to UL Platform.** Never point
> this at another asset's database (e.g. ultimalinha-landing) — see CLAUDE.md §2.

## Getting started

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and Supabase project values (own project!)
npm run db:generate    # generate SQL migrations from src/db/schema
npm run db:migrate     # apply migrations to DATABASE_URL
npm run db:seed        # idempotent: applications, roles, permissions, role_permissions, plans, plan_entitlements
npm run dev
```

## Scripts

- `npm run dev` — run the API with hot reload
- `npm run build` / `npm start` — production build and run
- `npm run typecheck` / `npm run lint` / `npm test`
- `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` — Drizzle Kit
- `npm run db:seed` — idempotent seed of the platform catalogs (applications, roles, permissions, plans, plan entitlements, service scopes, application service-scope allowlists)
- `npm run db:inspect` — dumps the live schema (tables/columns/constraints/FKs/indexes) for manual verification
- `npm run smoke` — live HTTP smoke test: starts the real app in-process and drives Service Scopes + Webhooks + Service Discovery + Platform Administration end to end (real bearer tokens, real API keys, a real local receiver verifying outbound signatures). Requires a migrated, seeded database; not part of `npm test`.
- `npm run platform:bootstrap-admin` — one-time creation of the platform's first `PLATFORM_ADMIN` (reads `PLATFORM_ADMIN_BOOTSTRAP_USER_ID`). See "Platform Control Plane" below.

## Structure

```
src/
  config/        env loading & validation
  db/            drizzle client + schema/ (one file per domain) + seed/
  integrations/  external providers (supabase)
  middleware/    authenticate, organization context, platform context, permission checks, errors
  modules/       domain services (users, memberships, authorization, audit, platformAdmins, platformAuthorization, ...)
  routes/v1/     versioned HTTP routes
  shared/        cross-cutting types/helpers (errors, response envelope)
scripts/         one-off/dev-only scripts (schema inspection, live HTTP smoke test, platform-admin bootstrap)
tests/           node:test suite (database/seed, authorization, identity, customer, organizations, memberships,
                 roles/permissions catalog, role-assignment security, applications catalog, plans/plan entitlements,
                 subscriptions, organization application access, effective entitlement resolution, API keys,
                 service scopes, webhooks, usage/metering, application environments/endpoints, service discovery/integrations,
                 platform administration)
```

## API — v1

- `GET /v1/health` — liveness, no auth, no dependencies (never touches PostgreSQL — see "Fase 16" below).
- `GET /v1/health/ready` — readiness, no auth. Checks PostgreSQL connectivity; `503` (never host/connection-string detail) if unreachable.
- `GET /v1/me` — the authenticated user + their memberships across organizations.
- `POST /v1/organizations` — create an organization; the caller becomes its OWNER atomically. Platform-level (auth only, no org context yet).
- `GET|PATCH|DELETE /v1/organizations/:organizationId` — requires active membership + `organization.read`/`update`/`delete`.
- `GET /v1/organizations/:organizationId/memberships` — requires `membership.read`.
- `POST /v1/organizations/:organizationId/memberships` — requires `membership.create`; body `{ userId, roleKey, status? }`. The target user must already have a platform `users` row (i.e. have authenticated at least once) — inviting someone who has never signed in isn't supported yet.
- `PATCH /v1/organizations/:organizationId/memberships/:membershipId` — requires `membership.update`; changing `roleKey` additionally requires `role.assign`.
- `DELETE /v1/organizations/:organizationId/memberships/:membershipId` — requires `membership.remove`.
- All membership role/status changes are blocked from demoting or removing an organization's last active OWNER (`409 CONFLICT`).
- Assigning the `OWNER` role to a membership, or changing/removing a membership that is currently an active `OWNER`, additionally requires the *actor's own* role to already be `OWNER` — `role.assign` alone (held by `ADMIN` too) is not enough. Prevents an `ADMIN` from minting a new `OWNER` (self or ally) or neutralizing an existing one. Enforced in the service layer (`assertOwnerRoleChangeAllowed`), not just at the route.
- `GET /v1/roles` / `GET /v1/roles/:roleKey` — the platform's global role catalog (`OWNER`/`ADMIN`/`MANAGER`/`STAFF`); detail includes the role's granted permission keys. Auth only, no organization context — roles are global, not per-tenant data.
- `GET /v1/permissions` / `GET /v1/permissions/:permissionKey` — the platform's global permission catalog. Same auth model as roles.
- `GET /v1/applications` / `GET /v1/applications/:applicationKey` — the platform's application registry (`UL_CONSOLE`, `NA_PISTA`, `MICHA_EXPRESS`, `FOI`, `QUALE_A_DICA`, `HOJE_TEM`). Read-only, auth-only — same reasoning as roles/permissions.
- `POST /v1/applications` / `PATCH /v1/applications/:applicationKey` — registers a new application / updates `name`/`description`/`status`. **Platform-only**: requires `platform.application.manage` (see "Platform Control Plane" below) — no Organization role, however senior, can reach these. No `DELETE`: `status` (`ACTIVE`/`SUSPENDED`/`DEPRECATED`) is the lifecycle lever, and `plans.applicationId` is `ON DELETE RESTRICT` anyway once an application has commercial history.
- `GET /v1/applications/:applicationKey/plans` — the application's commercial plans still open to new subscriptions (`status = ACTIVE` only). 404 if the application itself doesn't exist.
- `GET /v1/applications/:applicationKey/plans/:planKey` — one plan's full detail, including its entitlements — regardless of status (an `ARCHIVED` plan must still be inspectable, e.g. later by an existing subscription; it's just hidden from the list above). A plan can only be reached through its own application's key in the URL — the same plan `key` used by a different application (e.g. two apps both having a `"BUSINESS"` plan) never cross-resolves.
- `POST /v1/organizations/:organizationId/subscriptions` — subscribes the organization to `{ applicationKey, planKey }`; requires `subscription.manage` (OWNER-only in the seed, same posture as `organization.delete`). Rejects an unknown application/plan (`404`), a `SUSPENDED`/`DEPRECATED` application or `ARCHIVED` plan (`409` — new subscriptions only; existing ones are never touched), and a second non-canceled subscription for the same application (`409` — see below).
- `GET /v1/organizations/:organizationId/subscriptions` / `GET .../subscriptions/:subscriptionId` — requires `subscription.read`. Detail is tenant-safe by construction (`WHERE id = ... AND organization_id = ...` in one query) — a subscription from another organization 404s, it never leaks via a bare ID lookup.
- `PATCH /v1/organizations/:organizationId/subscriptions/:subscriptionId` — body `{ "status": "canceled" }` (the only transition v1 supports); requires `subscription.manage`. Canceling an already-canceled subscription is `409`, not a silent no-op. Subscriptions are never deleted — cancellation is a status change, preserving history.
- `GET /v1/organizations/:organizationId/applications` — the applications this organization currently has effective access to, derived live from its non-canceled subscriptions (no parallel `organization_applications` table). Requires `subscription.read` (it's a view over subscription data, not the global registry).
- `GET /v1/organizations/:organizationId/applications/:applicationKey/entitlements` — the Effective Entitlements resolved from the organization's current subscription for that application (see below). `404` if the application itself is unknown; `200` with `subscription: null, entitlements: []` if the organization has no granting subscription (that's a real, meaningful answer, not an error). Requires `entitlement.read` (existing permission, granted to `OWNER`/`ADMIN`/`MANAGER`, not `STAFF`) — deliberately not `subscription.read`: this answers "what capability values do we have", a different question from "what subscriptions do we have".
- `GET /v1/organizations/:organizationId/applications/:applicationKey/entitlements/:key` — one specific entitlement's effective value. `404` uniformly when there's no value for that key — whether because there's no granting subscription at all or because the plan simply doesn't include that key; the caller doesn't need to distinguish those.
- `POST /v1/organizations/:organizationId/api-keys` — creates an organization-scoped API key for `{ applicationKey, expiresAt? }`; requires `api_key.manage` (OWNER-only). Response includes the raw secret **exactly this once**.
- `GET /v1/organizations/:organizationId/api-keys` / `GET .../api-keys/:keyId` — metadata only, never the secret; requires `api_key.read` (`OWNER`/`ADMIN`).
- `POST /v1/organizations/:organizationId/api-keys/:keyId/revoke` — status change to `REVOKED`, never a delete; requires `api_key.manage`.
- `GET /v1/organizations/:organizationId/applications/:applicationKey/entitlements[/:key]` (above) additionally accepts a service credential (API key) whose own stored application+organization match the URL — see "API Keys" below. Every other endpoint in this API remains human-only.
- `GET /v1/service-scopes` — the full platform scope registry (`key`, `description`). Auth-only, same posture as `/v1/roles`/`/v1/permissions`.
- `GET /v1/applications/:applicationKey/service-scopes` — the subset of the registry that application's credentials may request. Lets an org admin see valid choices before calling `POST /organizations/:id/api-keys` with `scopes`.
- `GET /v1/service/me` — the service-credential analogue of `GET /v1/me`: returns the calling API key's own `apiKeyId`, `application`, `organizationId` and granted `scopes`. 403 for a human caller.
- `POST /v1/organizations/:organizationId/api-keys` (see "API Keys" below) now additionally accepts `scopes: string[]`; every requested scope is validated against the registry and the application's allowlist before the key is created.
- `POST /v1/organizations/:organizationId/webhooks` — creates a webhook endpoint for `{ applicationKey, url, eventTypes }`; requires `webhook.manage` (OWNER-only). Response includes the raw signing secret **exactly this once**.
- `GET /v1/organizations/:organizationId/webhooks` / `GET .../webhooks/:webhookId` — metadata only, never the secret; requires `webhook.read` (`OWNER`/`ADMIN`).
- `POST /v1/organizations/:organizationId/webhooks/:webhookId/revoke` — status change to `REVOKED`, never a delete; requires `webhook.manage`.
- `POST /v1/organizations/:organizationId/webhooks/:webhookId/test` — fires a synthetic `webhook.test` event at exactly this endpoint (bypassing its subscriptions), reusing the real delivery path; requires `webhook.manage`.
- `POST /v1/organizations/:organizationId/events` — **service-only**: publishes a platform event `{ type, data }` on behalf of the calling credential's own application/organization, delivering it to every `ACTIVE` webhook endpoint in that organization subscribed to that `type`. Requires the `event.publish` service scope. See "Service Scopes" and "Webhooks" below.
- `GET /v1/meters` — the full platform meter registry (`key`, `unit`, `description`). Auth-only, same posture as `/v1/service-scopes`.
- `GET /v1/applications/:applicationKey/meters` — the subset of the registry that application may record/query usage against.
- `POST /v1/organizations/:organizationId/applications/:applicationKey/usage` — **service-only**: records one usage event `{ meterKey, quantity, occurredAt?, idempotencyKey, metadata? }` for the calling credential's own application/organization. Requires the `usage.write` service scope. Returns `201` for a newly-recorded event, `200` for an idempotent replay of an existing `idempotencyKey` (same body, same row — never a second count). See "Usage / Metering" below.
- `GET /v1/organizations/:organizationId/applications/:applicationKey/usage` / `GET .../usage/:meterKey` — aggregated usage, optionally bounded by `?from=&to=` (ISO timestamps, either/both omittable). Accepts a human member with `usage.read` **or** a service credential whose own stored application/organization match the URL and which holds the `usage.read` scope. `200` with `quantity: 0` (or `meters: []`) for a range/application with no recorded usage — a real, meaningful empty answer, not an error.
- `GET /v1/applications/:applicationKey/environments` / `GET .../environments/:environmentKey` — an application's registered deployment contexts (`production`/`staging`), with `status`. Auth-only, same posture as `/v1/service-scopes`/`/v1/meters`.
- `POST /v1/applications/:applicationKey/environments` / `PATCH .../environments/:environmentKey` — registers an environment / changes its `status`. **Platform-only**: requires `platform.environment.manage`.
- `GET /v1/applications/:applicationKey/environments/:environmentKey/endpoints` — the network addresses (`type`, `baseUrl`, `status`) that environment exposes. Same auth posture; never returns a secret (there is none to return — endpoints have no credential of their own).
- `POST /v1/applications/:applicationKey/environments/:environmentKey/endpoints` / `PATCH .../endpoints/:endpointType` — registers an endpoint (`{ type: "API", baseUrl }`, validated exactly as before — HTTPS mandatory in `production`, no embedded credentials, no fragment) / changes its `status`. **Platform-only**: requires `platform.endpoint.manage`.
- `GET /v1/applications/:sourceApplicationKey/integrations` / `GET .../integrations/:targetApplicationKey` — the directional application-to-application integrations registered *from* this application. Same auth posture.
- `POST /v1/applications/:sourceApplicationKey/integrations/:targetApplicationKey` / `PATCH .../integrations/:targetApplicationKey` — registers a directional integration / changes its `status`/`description`. **Platform-only**: requires `platform.integration.manage`.
- `GET /v1/service/discover?target=<applicationKey>&environment=<environmentKey>` — **service-only**: Service Discovery. Resolves to `{ application: { key }, environment, endpoint: { type, baseUrl } }` for the calling credential's own application acting as the *source*. Requires a registered, `ACTIVE` integration from the caller's application to `target`, plus an `ACTIVE` environment and `ACTIVE` endpoint on the target — no service scope is checked here (see "Service Discovery" below for why). Never organization-scoped, never a query param a caller can override.
- `GET /v1/platform/me` — the platform-scope analogue of `GET /v1/me`: any authenticated human may check `{ platformAdmin: boolean, platformRole: string | null }` for themselves. Never a 403 for a non-admin — this is self-introspection, not an administrative action.
- `GET /v1/platform/admins` — the roster of everyone ever granted platform authority (active and revoked). Requires `platform.platform_admin.read`.
- `POST /v1/platform/admins` — grants `{ userId, platformRoleKey? }` to an existing platform user (never creates one). Requires `platform.platform_admin.manage` — see "Platform Control Plane" below for why this structurally cannot self-escalate.
- `PATCH /v1/platform/admins/:userId` — revokes/reactivates/reassigns `{ status?, platformRoleKey? }`. Requires `platform.platform_admin.manage`. Refuses (`409`) to revoke the platform's last active administrator.
- `GET /v1/platform/audit-logs` — the control-plane audit trail, cursor-paginated (`?cursor=&limit=`, `limit` capped at 100) and filterable by `action`/`actorUserId`/`targetType`/`targetId`/`from`/`to`. Requires `platform.audit.read`. Only ever returns control-plane events — see "Fase 15" below for the exact boundary and why it's the `action` namespace, not `organizationId`.
- `POST /v1/platform/credentials` — issues a platform-level (`organizationId = null`) API key for `{ applicationKey, expiresAt?, scopes? }` — an application's own service identity, never an Organization's. Requires `platform.credential.manage`. Response includes the raw secret **exactly this once**, identical contract to the organization-scoped form.
- `GET /v1/platform/credentials` — metadata only, never the secret; only ever `organizationId = null` rows. Requires `platform.credential.read`.
- `POST /v1/platform/credentials/:keyId/revoke` — status change to `REVOKED`, never a delete; can never reach an Organization's own key (`404` if `keyId` belongs to one). Requires `platform.credential.manage`.

### Applications are a registry, not a module boundary

An `Application` row (e.g. `NA_PISTA`) means "the platform knows this product exists" — it is never where that product's business logic (catalog, orders, wallet, delivery, ...) lives; that stays in the product's own independent repository. It also does **not** mean an Organization has commercial access to it — that's `Organization → Subscription → Plan` (see below). `applications.status` (`ACTIVE`/`SUSPENDED`/`DEPRECATED`, default `ACTIVE`) exists so an application can stop accepting new subscriptions or be retired without a physical delete — necessary because `plans.applicationId` is `ON DELETE RESTRICT`, so once an application has any plans, Postgres itself refuses to delete it; `status` covers the lifecycle *before* that FK protection would apply. No product-specific permissions (e.g. `na_pista.catalog.read`) and no `organization_applications` table were added — those belong to the future Subscription model or to the products themselves.

### Application → Plan → Entitlement (and what it is not)

```
Application ("NA_PISTA" — what product is this?)
   └── Plan ("BUSINESS" — which commercial offer of that product?)
         └── Plan Entitlement ("products.max" = 1000 — what does that offer include?)
```

Three distinctions that are easy to blur:

- **Entitlement ≠ Permission.** A `Permission` (e.g. `membership.create`) answers "what can this *actor* do?" and lives on `Role → Permission → Membership`. An `Entitlement` (e.g. `products.max = 1000`) answers "what capability/limit does this *commercial offer* include?" and lives on `Plan → Plan Entitlement`. They are unrelated tables serving unrelated questions — entitlements are never granted through the permission system, and permissions are never plan-scoped.
- **Plan ≠ Subscription.** A `Plan` is a standing offer ("Business exists and includes these entitlements"); nothing about it implies any Organization has it. `Organization → Subscription → Plan` is what establishes that (see next section). No `organization_id` appears anywhere in `plans` or `plan_entitlements`.
- **Application ≠ Organization access.** An `Application` existing (e.g. `NA_PISTA`) doesn't mean every Organization can use it — that commercial relationship is exactly what Subscription resolves (see next section).

`plan_entitlements` has no separate "entitlement definitions" catalog table (unlike `permissions`, which backs `role_permissions`): entitlement keys are not a fixed platform vocabulary the way permissions are — products define their own capability keys (`catalog.enabled`, `products.max`, ...) as needed, and a global definitions table would either sit empty or tempt the platform into knowing product-specific semantics it must not know (see CLAUDE.md §10). A `plan_entitlements` row belongs to exactly one plan, and a plan belongs to exactly one application, so a `NA_PISTA` plan cannot end up carrying a `micha_express.*`-style key by cross-referencing a shared table — there is no shared table to cross-reference. `value` is `jsonb` (same choice already made for the `entitlements` table) so booleans, integers and short strings are all representable without a separate type column.

`entitlements` (already in the schema — still not written to by anything, and deliberately still isn't as of this step) is a *different* table reserved for a *possible future* step: a *materialized* copy of Effective Entitlements. Do not conflate the two — `plan_entitlements` is the offer's definition, `entitlements` would be a cached/persisted resolved grant if one is ever needed. Effective Entitlements themselves are implemented (see next section) as a synchronous, unmaterialized resolution — no background job, no cache — precisely so this table could absorb that role later without an architecture change, if a concrete performance or product need ever justifies it.

### Organization → Subscription → Plan → Application

```
Organization
   └── Subscription (status: trialing | active | past_due | canceled)
         └── Plan ── Application
```

A `Subscription` is the fact "this Organization has this Plan" — it is the *only* source of truth for "does Organization X have access to Application Y"; there is no separate `organization_applications` table. `GET /v1/organizations/:id/applications` is a live derived view over subscriptions, not a cache of one.

**"Active" for access purposes means any status other than `canceled`** — `trialing` and `past_due` still represent a live relationship; only `canceled` is history. That single predicate is reused everywhere: the database's partial unique index, the per-application duplicate check, and the access-derivation query.

**At most one non-canceled subscription per (organization, plan)** is a real database constraint (`subscriptions_org_plan_not_canceled_unique`, a partial unique index — `CANCELED` rows are exempt, so history is never blocked). **At most one non-canceled subscription per (organization, *application*)** — the actually-important rule, since two different plans of the same application active at once would make "which plan's entitlements apply?" ambiguous — can't be expressed as a single-table index (Application is only reachable via `plans.applicationId`), so it's enforced transactionally in `createSubscription`: the transaction takes `SELECT ... FOR UPDATE` on the organization row first, serializing concurrent subscription-creation attempts for that organization before the duplicate check runs. Adding an `applicationId` column to `subscriptions` purely to get a database-level constraint for this was deliberately rejected as an unnecessary denormalization.

New subscriptions require the application `ACTIVE` and the plan `ACTIVE` — `SUSPENDED`/`DEPRECATED` applications and `ARCHIVED` plans reject *new* subscriptions (`409`) but never touch subscriptions that already exist; an organization already subscribed keeps access even if the application is later suspended or the plan archived. Canceling a subscription is a status change (`canceled` + `canceledAt`), never a delete — history is preserved, matching how Organizations/Memberships already work.

Worth naming explicitly: **"a subscription grants access" is not the same claim as "the application is currently operationally available."** The former (`status != canceled`) is about the *commercial relationship's* validity and is exactly what's documented above. The latter would be about whether `NA_PISTA` itself is up and reachable right now — the platform has no opinion on that here, doesn't track it, and `applications.status` (`SUSPENDED`/`DEPRECATED`) is a *gate on new subscriptions*, not a live operational-availability signal. No such policy is invented in this step.

### Effective Entitlements: resolving what a subscription actually grants

```
Application
   └── Plan
         └── Plan Entitlement ("products.max" = 1000 — what the offer includes)

Organization
   └── Subscription (granting, i.e. status != canceled)
         └── Plan
               └── Plan Entitlement
                     └── Effective Entitlement ("this organization's products.max is 1000, right now")
```

Five questions the platform can now answer (`modules/entitlements/service.ts`):
1. Does this organization have access to application X? → `hasApplicationAccess` (subscriptions module).
2. Which subscription grants that access? → the *granting subscription*: by construction (`createSubscription`'s transactional per-application uniqueness check is the only write path for subscriptions) there is at most one non-canceled subscription per (organization, application) today.
3. Which plan is currently granting that access? → `subscription.planKey` in the resolution result.
4. Which entitlements does that plan provide? → `plan_entitlements` for that plan.
5. What is the effective value of entitlement X? → `getEffectiveEntitlement(organizationId, applicationKey, key)`.

**No entitlement-merging engine was built.** Since at most one granting subscription per (organization, application) can exist through the only write path, there's nothing to merge — `getGrantingSubscription` still orders by most-recently-created and takes one row (rather than assuming exactly one) purely so resolution stays deterministic and never crashes if that invariant is ever relaxed later; it is not expected to matter in practice, and no max/min/OR/AND/sum merge rule was invented on the *chance* it might.

**Resolution is synchronous, not materialized.** Every read re-derives the answer via a live join (`subscriptions → plans → plan_entitlements`); nothing is written to the reserved `entitlements` table, there's no cache, no Redis, no background worker. This is a deliberate v1 choice for correctness and simplicity — see the `entitlements` table note above for when materialization might become worth revisiting.

**Permission ≠ Entitlement, restated concretely:** a user can hold `subscription.read` (a *Permission* — "may this actor view subscriptions") while their organization's plan has `feature.analytics = false` (an *Entitlement* — "does this organization's plan include analytics"). Neither implies the other, and neither is evaluated in terms of the other. The full chain this platform is converging toward is `Authentication → Application context → Organization context → Membership → Permission → Application access → Effective entitlement → Business operation` — this step establishes the last two links' *resolution mechanism* (`hasApplicationAccess`, `getEffectiveEntitlements`); wiring them into an actual authorization gate for a business operation is future work, not done here.

### API Keys: human authentication vs. machine authentication

Two authentication classes now exist and are never conflated:

```
Human                                    Machine
User → Supabase JWT → identity           Service/Application → API Key → identity
  → Organization membership                → Application context (always)
  → Permission                              → Organization context (when the key is org-scoped)
                                             → credential scope IS the authorization
```

A machine credential never impersonates a human: there is no fake `users` row, no fake `memberships` row for a service. `authenticate` populates exactly one of `req.auth` (human) or `req.service` (machine) per request — every existing human-only route keeps working completely unchanged, because it checks `req.auth`/`req.membership`, which simply stay unset for a service request; nothing needed to be retrofitted to explicitly reject services.

**Credential format:** `ulk_<id>.<secret>` — `ulk_` makes it unambiguously distinguishable from a Supabase JWT at a glance (a JWT is 3 dot-separated segments with no fixed prefix); `id` is the row's UUID primary key, safe to expose (it's how the row is found — O(1) via the PK index — not the secret itself); `secret` is 256 bits from `crypto.randomBytes`, base64url-encoded. **The secret is returned exactly once, at creation, and only its SHA-256 hash is ever persisted** — plain SHA-256, deliberately not bcrypt/scrypt/argon2: those algorithms' expensive work factor exists to slow brute-forcing a *low-entropy* human password, and a 256-bit CSPRNG secret is already computationally infeasible to brute-force regardless of hash speed, so a slow KDF would only tax every authenticated request for no real security gain. Comparison uses `crypto.timingSafeEqual`.

**Ownership/scope model:** an API key is always application-scoped (`applicationId`, resolved from the existing Application registry — no new application table) and *optionally* organization-scoped (`organizationId`, nullable). v1 only implements creation of the organization-scoped form — "Organization ABC's NA_PISTA integration" — via `POST /organizations/:id/api-keys`, authorized the same way as everything else (`api_key.manage`, an existing-style permission, OWNER-only in the seed). The platform-level form (`organizationId = null`, e.g. "the NA_PISTA backend itself") is schema-supported but **deliberately has no creation endpoint in v1**: there is no `PLATFORM_ADMIN` actor yet, and gating platform-wide credential issuance behind an *organization's* permission would let any OWNER mint a credential that isn't scoped to their organization at all — a privilege-escalation shape identical to the one already closed for role assignment. Provisioning a platform-level key today is a controlled manual/future-Console operation, not an HTTP-reachable one — this is a documented gap, not an oversight.

**Client-supplied scope is never trusted.** `organizationId` and `applicationId` for a service request come only from the stored credential row, resolved during verification — never from a request body, header, or route param. The one endpoint pair opened to service credentials (`middleware/entitlementAccess.ts`) checks the URL's `:organizationId`/`:applicationKey` *against* the credential's stored values and 403s on any mismatch; a key can never be used to reach a different organization or application than the one it was minted for.

**Lifecycle:** `status` is a small explicit `ACTIVE`/`REVOKED` — no larger state machine. Expiration is derived (`expiresAt <= now()`) at verification time rather than a third persisted status, so nothing needs a background sweep when a key's clock runs out. Revocation is a status change, never a delete (auditability). Rotation isn't automated in v1; the supported operational pattern is manual: create the new key → deploy its secret → verify it works → revoke the old one — the model doesn't block having two active keys for the same organization+application simultaneously during that window.

**Every verification failure looks identical from the outside** — malformed token, unknown id, wrong secret, revoked, expired, or the owning Application not `ACTIVE` all produce the same generic `401` (`modules/apiKeys/service.ts`'s `verifyApiKeyToken`), so a response can never be used to probe whether a given key id exists, was revoked, or belongs to someone else.

**Application lifecycle interaction:** a key whose Application is `SUSPENDED`/`DEPRECATED` stops authenticating immediately — checked live at verification time, nothing is mutated on the key rows themselves when an application's status changes. This is one clear rule (mirroring "no new subscriptions for a non-`ACTIVE` application"), not a cascading state machine.

**No `scopes` column.** v1's only scope dimension is *which application, which organization* — both already columns. A fine-grained action-level scope array would be unenforced schema decoration until there's an actual machine-consumable business endpoint that needs finer authorization than "this credential's identity matches this URL" — today there's exactly one such endpoint (Effective Entitlements, read-only), so credential scope alone is sufficient authorization for it. Add real scopes when a second, differently-permissioned machine endpoint actually needs them.

**Credential authentication ≠ Application access ≠ Effective Entitlement — still three separate questions**, not conflated by this step: possessing a valid API key answers only "is this a legitimate credential for application X (and organization Y, if scoped)". It does not by itself mean the organization has a Subscription, nor what that Subscription's Plan grants — a service calling the entitlements endpoint gets exactly the same `subscription: null, entitlements: []` a human would see if the organization isn't subscribed. No blanket "every API key requires a subscription" rule was invented.

**No `lastUsedAt`.** Tracking it would mean a database write on every authenticated request; doing that without unnecessary load needs an async/queued path this platform deliberately doesn't have (no Redis, no queues — see below). Omitted rather than half-implemented.

**Audit:** `api_key.created` and `api_key.revoked` are recorded (keyId, applicationId, organizationId, actor); no raw secret, hash, or bearer credential ever appears in an audit row, and successful authentications are not audited (matching "don't audit every GET").

**Deliberately future work, not built here:** automated rotation, rate limiting (API-key authentication is a natural future rate-limit target), OAuth client-credentials flow, and any concept of a "service account" richer than an (application, organization) pair — should the ecosystem ever need something between "one plain credential" and "a full IdP client."

### Service Scopes: what a service credential is authorized to do

API Keys answer *"who is this service?"*. Service Scopes answer *"what is this service authorized to do?"* — a separate, later question, never conflated with identity itself:

```
Service Credential (API Key)
    ↓
Application identity (from the credential, never the request)
    ↓
Organization context (from the credential, when org-scoped)
    ↓
Service Scopes (granted at creation, persisted, never re-derived from the request)
    ↓
Protected service operation (requireServiceScope("event.publish"), ...)
```

**Registry, not free-form strings.** `service_scopes` is a small, platform-seeded global vocabulary (`event.publish`, `catalog.read`, `catalog.write`, `customer.read`, `payment.create`, `payment.read`, `report.generate` — see `db/seed/data.ts`) — the service-identity equivalent of `permissions`. There is no endpoint to add to this registry: exactly the same reasoning as "no `role.manage` endpoint" (no `PLATFORM_ADMIN` actor yet to safely gate registry mutation — see "Role assignment vs. role definition" below). A caller can never grant itself `scope = "admin.everything"` merely by typing it — `validateRequestedScopes` (`modules/serviceScopes/service.ts`) checks every requested scope against this table first.

**Application allowlist, not just registry membership.** `application_service_scopes` is a join table — the *set* of registry scopes a given Application's credentials may ever request (e.g. `NA_PISTA` → `catalog.read`/`catalog.write`/`customer.read`/`event.publish`; `MICHA_EXPRESS` → `payment.create`/`payment.read`/`event.publish`). A scope that's real but not in *this* application's allowlist is rejected with `403 FORBIDDEN` — deliberately a different status than an unknown scope (`400 VALIDATION_ERROR`): one is a malformed request, the other is an authorization boundary. This is what makes cross-application scope escalation structurally impossible, not merely convention: a `QUALE_A_DICA` credential can never hold a `payment.create` scope, because that (application, scope) pair simply has no row to grant it from.

**Granted scopes are persisted per key, not re-evaluated per request.** `api_key_scopes` records exactly what was validated and granted at creation time. `verifyApiKeyToken` loads this set once per request into `req.service.scopes` — nothing about scope-checking ever re-reads the request body, so nothing a caller sends can widen its own credential. There is no scope-editing endpoint in v1: changing a key's scopes means creating a new key and revoking the old one, the same rotation pattern already documented for secrets.

**`requireServiceScope(scopeKey)`** (`middleware/requireServiceScope.ts`) is the reusable gate, the machine-identity equivalent of `requirePermission`. It 403s outright if `req.service` is unset (a human JWT can never satisfy a service scope — human and service authorization are different concerns per CLAUDE.md §6, never merged with a fallback check). The one scope wired to a real endpoint in v1 is `event.publish` on `POST /organizations/:id/events` (see "Webhooks" below); the middleware itself is generic and ready for a second, differently-scoped machine endpoint whenever one is needed.

**`requireServiceOrganizationMatch()`** (`middleware/requireServiceOrganizationMatch.ts`) is the companion organization-boundary check for service-only routes: it 401s a human request outright (an event's source must always be a real service identity, never a human session forging one) and 403s a credential whose *stored* `organizationId` doesn't match the route's `:organizationId` — the same "credential's own row is the authorization, not the URL" principle already used by `middleware/entitlementAccess.ts`, just generalized and made service-only.

**Entitlements are a different, orthogonal question.** A service can hold `scope: catalog.read` while its organization's plan does or doesn't include `entitlement: feature.catalog = true` — neither implies the other, and no protected operation in v1 is forced to check both (CLAUDE.md is explicit: "do not force every service-authenticated request to check subscription/entitlement"). The architecture supports composing `service scope + application access + effective entitlement` for a future protected operation that genuinely needs all three; nothing here builds that composition speculatively.

**Deliberately not built:** scope registry mutation via API (seed-only, see above), per-organization custom scopes, a scope hierarchy/wildcarding scheme (`catalog.*`), and any notion of scopes for human permissions (`permissions` and `service_scopes` remain two entirely separate tables answering two entirely separate questions).

### Webhooks: event notification, not a synchronous API

APIs answer *"do X / give me Y"*. Webhooks answer *"X happened"* — a fundamentally different shape of communication, kept in its own bounded context (`modules/webhooks/`), separate from Service Auth (`modules/apiKeys/`, `modules/serviceScopes/`):

```
MICHA_EXPRESS  →  POST /organizations/:id/events { type: "payment.completed", data }  →  UL Platform
                                                                                              │
                                                                              looks up ACTIVE endpoints
                                                                              in that org subscribed to
                                                                              "payment.completed"
                                                                                              │
                                                                                              ▼
                                                                          NA_PISTA's registered webhook URL
```

The platform transports and governs this event; it never interprets `type`/`data` — that meaning belongs entirely to the originating product (CLAUDE.md §18-19). No product-specific event types are seeded or validated beyond the generic `domain.action` shape.

**Webhook endpoints** (`webhook_endpoints`) are application- and organization-scoped exactly like `api_keys` — same ownership shape, same reasoning for why only the organization-scoped form is creatable over HTTP in v1 (no `PLATFORM_ADMIN` to safely authorize a platform-level/null-organization endpoint). `applicationId` names the *receiving* product context (e.g. "Organization ABC's NA_PISTA endpoint") — it does not restrict which *source* application's events can reach it; that's controlled entirely by explicit event-type subscriptions (`webhook_event_subscriptions`), never "deliver everything". A given `(endpoint, eventType)` pair is subscribed at most once (unique index).

**Webhook secret storage is deliberately NOT the API-key strategy.** `api_keys.secretHash` is a one-way SHA-256 hash because a key only ever needs to be *verified*. A webhook secret must also be *retrieved*, because the platform itself computes the outbound HMAC signature — a hash can't be reversed for that. So `webhook_endpoints.secretEncrypted` uses **AES-256-GCM** (authenticated encryption) under a platform-held key (`WEBHOOK_SECRET_ENCRYPTION_KEY`, env-only, 32 bytes base64 — see `modules/webhooks/crypto.ts`), not a hash. The raw secret (`whsec_<random>`, 256 bits from a CSPRNG) is still returned exactly once, at creation, and never re-exposed by any read endpoint. A tampered/corrupted ciphertext fails to decrypt (GCM's auth tag) rather than silently producing garbage that would sign outbound requests incorrectly.

**Event envelope** (`modules/webhooks/delivery.ts`'s `EventEnvelope`): `{ id, type, source: { application }, organizationId, occurredAt, data }`. `source.application` is always populated from the *already-authenticated* publishing credential's own `applicationKey` — never a request-body field, so a receiving product can trust it without any further check; nothing a client sends can rewrite who an event came from.

**Signature: `HMAC-SHA256(secret, "<unix-timestamp>.<rawBody>")`, hex-encoded** (`modules/webhooks/signature.ts`), sent as `X-UL-Signature` alongside `X-UL-Timestamp`, `X-UL-Event-Id`, `X-UL-Event-Type`. Signs the exact transmitted JSON bytes, deliberately not a re-serialization of a parsed object (which could reorder keys/whitespace and make an independently-computed signature disagree for reasons unrelated to tampering). `verifyWebhookSignature` also checks timestamp freshness (default tolerance: 300 seconds) — this is the platform's reference verification implementation for receivers to mirror, not a policy enforced on senders. **This alone is not replay protection**: it only proves "signed by this secret, recently". Consumers are responsible for tracking event IDs they've already processed.

**Idempotency: delivery is at-least-once, never exactly-once.** Every publish gets a globally unique `evt_<uuid>` event ID; a consumer must tolerate the same ID arriving more than once (there is no retry loop in v1 that would cause this today, but the model doesn't promise it never will). No dedup is attempted platform-side.

**Delivery (`modules/webhooks/delivery.ts`):** `deliverWebhook(endpoint, event)` is one HTTP POST and one `webhook_deliveries` row — success or failure, never a thrown exception (matching `recordAuditEvent`'s "never break the calling operation" posture). `publishEvent(...)` resolves the matching `ACTIVE` + subscribed endpoints for one organization/event-type and delivers to each independently — one endpoint's failure/unreachability never blocks another's delivery. Delivery is synchronous within the publishing request in v1 (no queue): CLAUDE.md explicitly rules out introducing Redis/Kafka/workers for this step. `webhook_deliveries.attempt` (default `1`) exists so a *future* retry mechanism can increment it without a schema change — v1 makes exactly one attempt and does not implement backoff, max-attempt limits, or dead-lettering.

**`POST /organizations/:id/events`** is the one and only trigger for delivery — service-only (`requireServiceOrganizationMatch` + `requireServiceScope("event.publish")`), never human. This keeps "who may claim an event happened" cryptographically tied to a real service identity, never a request body claim.

**`POST /organizations/:id/webhooks/:webhookId/test`** fires a synthetic `webhook.test` event at exactly one endpoint, deliberately bypassing its event-type subscriptions (an explicit test request is itself the authorization to deliver) — and reuses `deliverWebhook` directly, so a passing test is a real signal live delivery will work, not a separate mocked path.

**Tenant isolation**, same pattern as everywhere else in this API: every webhook query has `organizationId` in its `WHERE` clause by construction (never checked after the fact), a revoked endpoint stops receiving deliveries immediately (checked live at publish time, nothing mutated on already-recorded deliveries), and a service credential can only ever publish into its own stored `organizationId` (`requireServiceOrganizationMatch`).

**Audit:** `webhook.created` and `webhook.revoked` only — individual delivery attempts are operational data (`webhook_deliveries`), not audit-log events, matching "don't audit every GET"/"don't audit every delivery attempt" (CLAUDE.md §34). No secret, encrypted or otherwise, ever appears in an audit row.

**Deliberately future work, not built here:** automatic retries/backoff/dead-lettering, a queue or worker of any kind, per-event-type payload schemas or a global event-type catalog, webhook secret rotation UX beyond "create new endpoint, revoke old one", and delivery batching.

### Usage / Metering: what actually happened, not billing

Three questions this platform keeps deliberately separate, restated for this step:

```
Permission   → "What is this actor allowed to do?"        (Role → Permission → Membership)
Entitlement  → "What does the plan provide?"               (Plan → Plan Entitlement)
Usage        → "How much has actually been consumed?"      (Usage Event → Aggregation)
```

```
Application
   └── Plan
         └── Plan Entitlement   ("products.max" = 1000 — what's provided)

Organization
   └── Usage Event ×N   ("+1 order", "+5000 bytes", ...)
         └── Aggregation        ("products used: 742 — what's actually happened")
```

**This step is deliberately small and stops at "record and query".** It does not compute `742 < 1000`, does not reject a usage write because an entitlement would be exceeded, and does not charge for overage. See "Enforcement" below for exactly where the line is drawn and why.

**Meter registry, mirroring Service Scopes exactly.** `meters` (global, seeded: `users`, `orders`, `transactions`, `messages`, `storage_bytes`, `api_requests` — illustrative examples, not real product telemetry) is the measurement-definition equivalent of `service_scopes`; `application_meters` is the per-application allowlist join table, equivalent to `application_service_scopes`. A Meter and a Scope answer different questions and are never coupled to each other — `application_meters` has no foreign key to `service_scopes` or vice versa. Exactly like scopes, there's no HTTP endpoint to register a new meter (no `PLATFORM_ADMIN` yet — see CLAUDE.md §11); this is a controlled seed.

**Usage events are immutable and append-only.** `usage_events` has no update endpoint and nothing in this codebase ever mutates a row after insert. A correction is a new event (e.g. a negative-quantity adjustment), never an edit of history — the same posture already established for audit logs and webhook deliveries.

**Quantity is `numeric(20, 6)`, never `integer` or `double precision`.** Exact decimal storage avoids floating-point drift when many rows are summed, while still allowing fractional quantities a plain integer couldn't represent. The bound (20 total digits, 6 decimal places) is a deliberate ceiling, not unbounded `numeric` — a malformed value can't silently create an unbounded-precision row. The API accepts `quantity` as either a JSON number or a decimal string and always normalizes to a string before it reaches Postgres, since a JSON number is an IEEE-754 double and round-tripping a large/precise value through one would reintroduce exactly the imprecision this column type exists to avoid. Aggregated sums are converted to a plain JS `number` in API responses for ergonomics (matching the spec's own example response shape) — fine for realistic usage magnitudes; a future consumer that needs exact arbitrary-precision totals should read `usage_events.quantity` directly rather than trust the aggregated JSON number.

**No `period` column.** A day, a month, or an arbitrary `from`/`to` range are all always derivable from `occurredAt` at query time (`modules/usage/service.ts`). Persisting a redundant bucket string would duplicate `occurredAt` and still couldn't represent an arbitrary range a persisted bucket doesn't align to. Query ranges are plain `?from=&to=` ISO timestamps — no `period=month` shorthand in v1; a reasonable future addition, not built now.

**Idempotency is a real database constraint, not application-code discipline.** `usage_events_idempotency_unique` is a unique index on `(organizationId, applicationId, meterId, idempotencyKey)`. `recordUsage` does `INSERT ... ON CONFLICT DO NOTHING`, and when the insert conflicts (same key resubmitted), it re-selects and returns the *original* row instead — the caller gets back the same event either way, and the response's `idempotent: true/false` field tells it which happened. This makes concurrent duplicate submissions safe without any application-level locking: Postgres's unique index resolves the race, not this code. A single external event that must fan out into multiple meters (e.g. one order affecting both `orders` and `revenue_cents`) can reuse the same `idempotencyKey` for each — uniqueness is scoped per-meter, not globally per-key, specifically so that's possible.

**Service authentication, mirroring the events-publish pattern exactly.** `POST .../usage` requires `requireServiceOrganizationMatch()` + a new sibling `requireServiceApplicationMatch()` + `requireServiceScope("usage.write")`. `organizationId`/`applicationKey` are read only from the already-authenticated credential's own stored row — never trusted from the URL by themselves; the middleware is what enforces the two actually match. A NA_PISTA credential can no more record `MICHA_EXPRESS`'s usage than it can record a meter `MICHA_EXPRESS` alone is allowed (`application_meters`) — two independent boundaries, both enforced.

**Human + service read, kept as two genuinely separate paths (`middleware/usageAccess.ts`'s `requireUsageReadAccess`).** A human needs an active Membership *and* the `usage.read` permission (granted to `OWNER`/`ADMIN`/`MANAGER`, not `STAFF` — same tier as `entitlement.read`). A service needs its own stored organization+application to match the URL *and* the `usage.read` scope — unlike `requireEntitlementAccess` (built before service scopes existed, where identity-match alone was sufficient), a usage read is additionally scope-gated because a product may reasonably want to record usage without also being able to read it back, or vice versa.

**Enforcement is explicitly out of scope for this step.** The platform can now answer "how much has this organization consumed" and, separately, already answers "what does its plan provide" (Effective Entitlements) — but nothing here combines the two. Recording usage never checks any entitlement, never rejects a write for exceeding a limit, and never triggers an automatic upgrade, block, or grace period. A future enforcement layer can combine `getEffectiveEntitlement` + `getUsageForMeter` (both already synchronous, pure query functions) into a limit check — deliberately not built now, so the platform stays a fact-recorder, not an opinion-haver, about what an organization is "allowed" to consume.

**No billing, ever, from this table alone.** Usage → Pricing → Billing is explicitly a distinct, much later concern (if it's ever built at all) that would need to know a product's commercial rules — UL Platform records the fact of consumption; it does not know or compute what that consumption costs. Micha Express's own financial rules, Na Pista's order volume, and Hoje Tem!'s operational capacity are examples precisely because none of them require the platform to understand any of their internal business logic.

**Lifecycle: usage is history, never rewritten.** Canceling a subscription, archiving a plan, or suspending/deprecating an application never mutates or deletes previously recorded usage — `usage_events.applicationId`/`meterId` are `ON DELETE RESTRICT` (same posture as `api_keys.applicationId`/`plans.applicationId`), and no code path here touches existing rows in response to any of those lifecycle changes. In practice, a suspended application's API keys already stop authenticating entirely (see "API Keys" above) before a usage-write request could ever reach `recordUsage` — this module doesn't re-implement that gate, it relies on the one that already exists.

**Audit: usage events are not audit events.** Usage is high-volume operational data, not a security-sensitive administrative action — recording it is never written to `audit_logs` (matching "don't audit every GET"/"don't audit every delivery attempt", now extended to "don't audit every usage event"). If meter *configuration* (the registry itself) ever becomes mutable in the future, that would be a reasonable thing to audit; recording a fact is not.

**Performance: one composite index, chosen for the one real query shape.** `usage_events_query_idx` on `(organizationId, applicationId, meterId, occurredAt)` directly matches `getUsageForMeter`/`getUsageForApplication`'s access pattern (equality on org+app+meter, range on `occurredAt`); its leftmost prefixes also serve the org-only and org+app-only queries `getUsageForApplication` needs. No separate single-column indexes were added on top of it — a high-volume append-only table gets exactly the indexes its actual queries need, not every combination that could theoretically be queried.

**Aggregation happens at query time, no materialized totals.** Every read re-sums `usage_events` live; there is no cache, no scheduled aggregation job, no Redis counter. This mirrors the same v1 choice already made for Effective Entitlements, for the same reason: correctness first, revisit only if a concrete performance need ever shows up.

**Deliberately future work, not built here:** limit enforcement combining usage with entitlements, overage pricing/billing of any kind, automatic upgrades or blocking, retention/archival policy, partitioning, usage-threshold webhooks (`usage.threshold_reached` is explicitly not implemented — usage and event infrastructure remain separate concerns), and a `period=month`-style query shorthand.

### Application Environments, Endpoints, Integrations & Service Discovery

This step answers a fourth, still-separate question, layered on top of everything above:

```
Application    → "what product is this?"                (Application registry)
Environment    → "which deployment of it?"               (production / staging)
Endpoint       → "where do I reach that deployment?"      (a base URL)
Integration    → "is application A allowed to know about application B at all?"
Service Scope  → "what may A actually ask B to do?"
Service Discovery → the lookup that turns the first four into an address
```

**UL Platform is not an API Gateway.** It never proxies a request between products (CLAUDE.md's discovery prompt §3): `QUALÉ_A_DICA → NA_PISTA` traffic goes directly from one product to the other. UL Platform's only role is to answer, once, "where is NA_PISTA's production API" — the same shape of information as `service_scopes` answers "what may I ask it" and `webhooks` answer "how do I hear when it changes something". None of these three routes traffic; they only carry configuration and authorization *about* traffic that stays direct.

**Environment** (`application_environments`) is a deployment context belonging to exactly one Application — `key` unique per application (mirrors `plans.key`), status `ACTIVE`/`INACTIVE` (no `DRAINING`/`MAINTENANCE`/etc. — a small explicit lifecycle, not a state machine). A local development environment is never registered here; it exists only on a developer's machine and nothing platform-wide needs to resolve it.

**Endpoint** (`application_endpoints`) is a network address one Environment exposes — at most one per `(environment, type)`, a real unique index. `type` is a closed enum (`API` only in v1 — CLAUDE.md's discovery prompt §8 explicitly asks not to pre-invent ten endpoint types for hypothetical future use). URLs are validated server-side (`modules/endpoints/validation.ts`): must be a valid absolute `http(s)` URL, **HTTPS is mandatory in the `production` environment** (never relaxed for convenience — a non-`production` environment may use `http` since it's expected to point at a developer/staging box), no embedded userinfo (`https://user:pass@host` — a URL is a location, never a credential carrier), no fragment.

**No separate `domains` table.** A "domain" would only ever be the host portion of an endpoint's `baseUrl`, derivable by parsing it — an independent row for it would duplicate information already in `application_endpoints` without representing anything new. The objective here is "where is this application's service", not DNS management (CLAUDE.md's discovery prompt §10).

**Integration** (`application_integrations`) is a **directional**, platform-level statement: "Application A is formally registered to communicate with Application B". `A→B` and `B→A` are different rows — creating one never implies the other (enforced by a unique index on the ordered pair `(sourceApplicationId, targetApplicationId)`, not application-code discipline). Deliberately no `organizationId` on this table: v1 keeps integrations platform-level only, per CLAUDE.md's discovery prompt §22 — nothing here has yet needed an organization-specific override of "may A talk to B at all", and inventing that abstraction speculatively was rejected.

**Integration ≠ Authorization.** A registered, `ACTIVE` integration answers exactly one question — "may this pair know about each other at all" — and nothing more. It grants no capability by itself: the actual synchronous API call between the two products still needs the *target's own* Service Scope check, and (where relevant) its own organization-context check. Symmetrically, holding a Service Scope for an application never implies an Integration is registered — Service Discovery checks the integration registry and nothing else (see below); a target's own business endpoint checks its own scope and nothing else. These are two independent gates on two different steps of the same flow, never merged into one check.

**Service Discovery** (`modules/discovery/service.ts`, `GET /v1/service/discover`) is the lookup that ties Environment + Endpoint + Integration together:

```
authenticate (API key)
   ↓
source = req.service.applicationKey   — never a query/body field (§19)
   ↓
target application must exist and be ACTIVE           → 404 otherwise
   ↓
an ACTIVE Integration source→target must exist         → 403 otherwise
   ↓
target's requested Environment must exist and be ACTIVE → 404 otherwise
   ↓
target's `API` Endpoint must exist and be ACTIVE        → 404 otherwise
   ↓
{ application: { key }, environment, endpoint: { type, baseUrl } }
```

Two deliberately different rejection shapes: `404 NotFoundError` for "there is currently nothing to find" (unknown/inactive application, environment, or endpoint — uniform on purpose, a caller doesn't need to know *why* an address isn't available, only that it isn't) versus `403 ForbiddenError` for exactly one thing, a missing or `INACTIVE` Integration — the one authorization boundary Discovery itself enforces. **Discovery never checks a Service Scope.** That check belongs entirely to the target application, at the moment the source actually calls it — Discovery only answers "where", never "may you".

**Source identity can never be spoofed.** `sourceApplicationKey` is always `req.service.applicationKey`, resolved from the already-verified API key — there is no `source` field anywhere in the request Discovery reads. **Discovery is not organization-scoped at all** — its query accepts only `target` and `environment`; an `organizationId` supplied anywhere is simply never read. Discovering "where is NA_PISTA's production API" answers nothing about which of NA_PISTA's organizations the caller may then act on — that remains entirely NA_PISTA's own authorization to enforce once the direct call actually arrives (CLAUDE.md's discovery prompt §21).

**Nothing secret is ever in a Discovery response** — no API key, no webhook secret, no internal database id, no infrastructure metadata beyond the one endpoint's `type`/`baseUrl`. Configuration (an application's own base URL) and secrets (its credentials) are different categories, and Discovery only ever returns the former.

**Who may manage platform applications?** Same answer as the Application registry itself already gives (see "Applications are a registry, not a module boundary" above): there is no `PLATFORM_ADMIN` actor yet, so an organization's `OWNER`/`ADMIN` permissions must never be allowed to mutate platform-wide infrastructure (CLAUDE.md's discovery prompt §26 is explicit about this). `modules/environments`, `modules/endpoints` and `modules/integrations` each expose real `create*`/`update*Status` functions — validated, duplicate-rejecting (a real database unique constraint, translated to `ConflictError`), and audited (`environment.created`/`.updated`, `endpoint.created`/`.updated`, `integration.created`/`.updated`) — but **no HTTP route calls them yet**. This mirrors the exact posture already established for `role_permissions` mutation and platform-level (`organizationId = null`) API keys: the logic exists, is fully tested, and is ready to be wired to a future Console-authenticated route without changing this layer; only the privileged HTTP surface is deferred until a real platform-admin context exists. Every `GET` route in this feature is auth-only, exactly like `/v1/roles`/`/v1/service-scopes`/`/v1/meters`.

**Seed data is honest about what it is.** `production`/`staging` environment *labels* are seeded for every real product application (just names, not addresses — safe to invent). Exactly two illustrative `staging` endpoints are seeded, using `.example` domains (RFC 2606 — reserved for documentation, guaranteed to never resolve), so nothing could be mistaken for real infrastructure. **No `production` endpoint is seeded for any application** — CLAUDE.md's discovery prompt §27 is explicit that this platform does not invent production URLs on a product's behalf; a real product supplies its own once it has one. Three integrations are seeded, taken directly from CLAUDE.md's own illustrative examples: `QUALE_A_DICA→NA_PISTA`, `NA_PISTA→MICHA_EXPRESS`, `HOJE_TEM→QUALE_A_DICA`.

**Webhooks are unaffected — this is the missing synchronous half.** The full picture is now:

```
Application A
    │
    ├── Service Auth (API Key)      — "who is A?"
    ├── Service Scope                — "what may A ask for?"
    │
    ├── Service Discovery            — "where does B live?"
    │          ↓  (direct call, never proxied)
    │      Application B
    │
    └── Webhook subscription         — "tell me when B changes something"
               ↑
          Application B
```

Synchronous (`A → discover B → call B directly`) and asynchronous (`B → webhook event → A`) are still two entirely separate mechanisms, never merged — Service Discovery tells A where B lives; Service Scopes authorize what A may request; Webhooks notify A when B changes something relevant. None of the three becomes the other.

**Deliberately not built:** an API Gateway/reverse proxy of any kind, DNS management, a load balancer or service mesh, Kubernetes-style discovery, automatic health monitoring or failover, caching of discovery results (query-time lookup only, indexed for it — see `application_environments_application_key_unique`, `application_endpoints_environment_type_unique`, `application_integrations_source_target_unique`), and organization-scoped integrations (platform-level only, see above). Mutation HTTP endpoints for environments/endpoints/integrations *were* deferred here pending a `PLATFORM_ADMIN` actor — Phase 13 ("Platform Control Plane" below) is that actor; the routes now exist, gated behind it.

### Platform Control Plane

Phase 12 established four global resources (Applications, Environments, Endpoints, Integrations) with service-layer mutations that had no safe HTTP surface, because nothing yet distinguished "an Organization's OWNER" from "someone who may administer the platform's own infrastructure." Phase 13 builds that missing actor:

```
Última Linha
     │
     │ HTTPS / API (future)
     ▼
UL Console                              ← NOT built in this phase, and will
     │                                     never touch PostgreSQL directly
     │ HTTPS / API
     ▼
UL Platform
     │
     ├── Platform RBAC (platform_roles/platform_permissions/platform_memberships)
     ├── Application Registry            (mutable: PLATFORM_ADMIN only)
     ├── Environments / Endpoints        (mutable: PLATFORM_ADMIN only)
     ├── Integrations                    (mutable: PLATFORM_ADMIN only)
     ├── Platform Audit                  (read: PLATFORM_ADMIN only, control-plane events only)
     ├── Platform Credentials            (organizationId = null API keys — PLATFORM_ADMIN only)
     ├── Service Discovery               (Console reuses the registry endpoints above — see Fase 15)
     ├── Webhooks                        (organization-scoped only — see Fase 15, not built platform-level)
     └── Usage                           (organization-scoped only — see Fase 15, not built platform-level)
     │
     ▼
PostgreSQL
```

**Two authority contexts, never merged.** `Organization RBAC` (`roles`/`permissions`/`memberships` — OWNER/ADMIN/MANAGER/STAFF, scoped to one Organization each) and `Platform RBAC` (`platform_roles`/`platform_permissions`/`platform_memberships` — v1 seeds exactly one role, `PLATFORM_ADMIN`, scoped to the platform itself, not to any Organization) are two separate table families with no foreign key between them and no shared middleware. `requireOrganizationMembership`/`requirePermission` never consult `platform_memberships`; `requirePlatformMembership`/`requirePlatformPermission` (`middleware/platformContext.ts`, `middleware/requirePlatformPermission.ts`) never consult `memberships`. A user can simultaneously be an Organization's OWNER and the platform's PLATFORM_ADMIN — holding one implies nothing about the other, by construction, not by convention.

**`PLATFORM_ADMIN` is resolved from `req.auth.userId` alone, never a route param.** Unlike `requireOrganizationMembership(paramName)`, which scopes by `:organizationId` in the URL, there is exactly one platform to administer — `platform_memberships` is unique on `userId` alone (`platform_memberships_user_unique`), not `(userId, somethingId)`. A service credential (`req.service`) is rejected outright with `403`, the same posture `requireServiceScope` already uses in the opposite direction (CLAUDE.md §6: human and service authentication are different concerns, never conflated) — platform administration is human-only.

**Platform permissions are their own namespace, not new rows on `permissions`.** `platform_permissions` seeds nine keys: `platform.application.manage`, `platform.environment.manage`, `platform.endpoint.manage`, `platform.integration.manage`, `platform.platform_admin.read`, `platform.platform_admin.manage`, and — added in Fase 15, see below — `platform.audit.read`, `platform.credential.read`, `platform.credential.manage`. Reading the Application/Environment/Endpoint/Integration registries stays exactly as open as it always was (any authenticated user, unchanged from Phase 12) — only *mutating* them is new, and that is exactly what these six permissions gate. No `platform.application.read`-style permissions were added: they would have zero consumers (the existing `GET`s are deliberately still auth-only) and Phase 13's own discipline ("não criar dezenas de permissions sem necessidade") argues against a permission nothing checks. `platform.platform_admin.read` is the one read permission that does exist, because listing who holds platform authority is itself sensitive — the same reasoning `api_key.read` already established for listing an organization's credentials.

**Bootstrap: the first `PLATFORM_ADMIN` is never created over HTTP.** `npm run platform:bootstrap-admin` (`scripts/bootstrap-platform-admin.ts` → `modules/platformAdmins/bootstrap.ts`) reads a target user id from the `PLATFORM_ADMIN_BOOTSTRAP_USER_ID` environment variable — never a value logged, never a secret (it's a UUID, not a credential) — and requires that user to already have a platform `users` row (i.e. have signed in via Supabase Auth at least once; this never creates a Supabase or platform user). It is idempotent for the same target, and refuses outright once *any* other active administrator already exists — bootstrap is a one-time event, not a standing side-channel for adding a second admin that bypasses `platform.platform_admin.manage` authorization. Every subsequent administrator is granted by an existing one through `POST /v1/platform/admins`, which is only reachable by someone who already holds `platform.platform_admin.manage` — structurally closing the "Organization OWNER promotes themselves to PLATFORM_ADMIN" escalation path this brief calls out explicitly: there is no code path from organization authority to platform authority, only from existing platform authority to new platform authority (plus the one non-HTTP bootstrap seam).

**Last-active-admin protection**, mirroring the "cannot demote an organization's last active OWNER" rule `updateMembership` already enforces: `updatePlatformAdmin` (`modules/platformAdmins/service.ts`) refuses (`409`) to revoke the platform's sole remaining `ACTIVE` `platform_memberships` row, whether the actor is revoking someone else or themselves. Revocation is a status change (`ACTIVE` → `REVOKED`), never a delete — the roster (`GET /v1/platform/admins`) shows full history, matching how API keys/webhook endpoints/environments already treat "removed" as a status, not an erasure.

**`PLATFORM_ADMIN` ≠ unrestricted tenant access — enforced by omission, not a check.** No code path grants a platform administrator implicit access to `customers`, `memberships`, `subscriptions`, or any other organization-scoped table; `requirePlatformMembership`/`requirePlatformPermission` are wired only onto the four global-resource route files (`applications.ts`, `environments.ts`, `integrations.ts`, `platform.ts`) and nowhere near `organizations.ts`/`memberships.ts`/`customers.ts`/etc. A `PLATFORM_ADMIN` who is not separately an Organization member gets exactly the same `403` from `requireOrganizationMembership` any other stranger would. `tests/platform-administration.test.ts` asserts this directly: a freshly-bootstrapped platform admin's `findActiveMembership` against an arbitrary organization id still resolves to `null`.

**Global resources administered here:** Applications (`POST`/`PATCH /v1/applications[/:key]`), Environments (`POST`/`PATCH .../environments[/:key]`), Endpoints (`POST`/`PATCH .../endpoints[/:type]`), Integrations (`POST`/`PATCH .../integrations/:target`) — see "API — v1" above for exact routes. No `DELETE` on any of them: every one already had a lifecycle `status` (`ACTIVE`/`SUSPENDED`/`DEPRECATED` for Applications, `ACTIVE`/`INACTIVE` for the rest) *and* an `ON DELETE RESTRICT` foreign-key story before Phase 13 — deleting was never the intended lever, `status` is. The mutation service functions for Environments/Endpoints/Integrations are byte-for-byte the Phase 12 functions (`createEnvironment`, `updateEnvironmentStatus`, `createEndpoint`, `updateEndpointStatus`, `createIntegration`, `updateIntegrationStatus`) — already validated, audited and tested; Phase 13 only added the HTTP surface and the permission gating it. `updateIntegrationStatus` gained one new optional `description` field (its `status` argument became optional too) so `PATCH` can update either independently, matching what `updateIntegrationSchema` accepts.

**Service Scopes and Meters stay read-only — a deliberate scope decision, not an oversight.** CLAUDE.md's Phase 13 brief explicitly allows leaving these registries untouched if nothing concretely needs mutation yet, and nothing does: no product has asked to add a scope or meter, and Phase 13's own stated objective (Applications/Environments/Endpoints/Integrations/PlatformAdmin) never mentions them. Adding `platform.service_scope.manage`/`platform.meter.manage` now would be permissions with zero callers. Revisit when a real product integration needs a new scope or meter — the same "registry, seed-only, no endpoint yet" posture these two tables have always had (see "Service Scopes" above).

**Audit**, reusing `audit_logs` — no second logging system: `platform.application.created`/`.updated`, `platform.admin.created`/`.updated`/`.revoked`. Environment/Endpoint/Integration mutations keep their existing Phase 12 action names (`environment.created`/`.updated`, `endpoint.created`/`.updated`, `integration.created`/`.updated`) unchanged — those functions and the tests asserting those exact strings already existed and were not rewritten; inventing new `platform.*`-prefixed names for them here would have been a gratuitous breaking rename with no functional benefit. No password, JWT, API secret or any credential is ever written to `metadata` — there is none to write; platform-admin audit metadata carries only `targetUserId`/`platformRoleKey`/`status`, the same non-secret shape every other audit entry in this codebase already uses.

**UL Console will consume these APIs; it will never open a direct connection to PostgreSQL.** Every capability Phase 13 exposes — `platform.me`, the admin roster, application/environment/endpoint/integration mutation — is reachable only through the versioned `/v1` HTTP surface, authenticated with the same Supabase JWT a human already uses everywhere else in this API. Building the Console itself remains explicitly out of scope for this phase.

**Deliberately not built:** an API Gateway/reverse proxy, DNS management, a load balancer or service mesh, Kubernetes-style discovery, Redis, Kafka, queues, automatic health monitoring or failover, a billing/payments/subscription-billing engine, generic tenant-private-data administration for `PLATFORM_ADMIN`, a second/richer platform role beyond `PLATFORM_ADMIN` (the `platform_roles` catalog table exists so adding one later is a data change, not a schema change), a custom OAuth flow, and the UL Console frontend itself.

### Fase 15 — Control Plane Observability & Credentials

Closes the gaps Fase 14 (UL Console) found: Audit, Service Discovery, API Keys, Webhooks and Usage each needed an explicit "build or don't" decision, not a default yes. CLAUDE.md's Fase 15 brief's own principle: `PLATFORM_ADMIN` must never become an administrator of tenant data just because the Console wants a page.

**Platform Audit (`GET /v1/platform/audit-logs`, `platform.audit.read`) — built.** `audit_logs` already carries both tenant events (`membership.*`, `organization.*`, `subscription.*`, `webhook.*`, `api_key.*` — always written with `organizationId` set) and control-plane events (`platform.*`, `environment.*`, `endpoint.*`, `integration.*` — never written with it). The real security boundary is **the `action` string's own namespace** (`CONTROL_PLANE_ACTION_PREFIXES` in `modules/audit/service.ts`), not `organizationId IS NULL` — that was the first design, and it was wrong: `audit_logs.organizationId` is `ON DELETE SET NULL`, so once a smoke/test run (or a real tenant offboarding) deletes an Organization, every tenant event that ever referenced it retroactively reads `organizationId: null` too. In this dev database, that had already happened to all 228 historical `api_key.created` rows. `organizationId IS NULL` is kept as a second, redundant condition (defense in depth), but the action-prefix allowlist is what actually holds the line — see `tests/platform-audit.test.ts`'s "organizationId retroactively nulled by ON DELETE SET NULL" regression test, which reproduces exactly this. Cursor-paginated (`(createdAt, id)` keyset, never `OFFSET`), `limit` capped at 100 by the Zod schema (a client asking for `limit=1000000` gets `400`, not a clamp).

**Service Discovery admin — evaluated, not built as a new endpoint.** The real `discoverService()` (`GET /v1/service/discover`) requires a `sourceApplicationKey` and its one authorization check is "does an ACTIVE Integration exist source → target" — a service-to-service concept with no meaning for a human `PLATFORM_ADMIN` browsing the registry (an admin isn't "a source application"). A parallel `/v1/platform/service-discovery` endpoint would only re-expose data the Console already has through the existing, already-auth-only `GET /v1/applications/:key/environments/:envKey/endpoints`. UL Console's `/service-discovery` page is a UX-only convenience (pick an application, pick an environment, see the endpoint) built entirely on that existing contract — no new backend route, no new permission.

**Platform Credentials (`/v1/platform/credentials`, `platform.credential.read`/`.manage`) — built.** `api_keys.organizationId` has been nullable *by explicit design* since Fase 12 (see the schema comment on `db/schema/apiKeys.ts`) for exactly this: "a platform/product-level service identity (e.g. 'the NA_PISTA backend itself')". `createPlatformApiKey`/`listPlatformApiKeys`/`revokePlatformApiKey` (`modules/apiKeys/service.ts`) are the org-scoped functions' direct siblings — same secret generation, same scope validation, same shown-once contract — hard-scoped to `organizationId = null` in every query, so this can never read or revoke an Organization's own key (see `tests/platform-credentials.test.ts`'s cross-scope isolation tests). Audited as `platform.credential.created`/`.revoked`, distinct from the tenant `api_key.created`/`.revoked` action names so the two are never ambiguous in the audit log.

**Webhooks (platform-level) — evaluated, not built.** Unlike `api_keys`, `webhook_endpoints.organizationId` is `NOT NULL` with no comment anticipating a platform form — there was never a schema-level intent here. No concrete need was identified either (what would a "platform webhook" even notify about — `platform.application.created`? nothing currently publishes control-plane events through the webhook delivery path). Revisit only if a real product asks to be notified of control-plane changes.

**Usage (platform-level) — evaluated, not built.** 100% organization-scoped end to end (`modules/usage`, `routes/v1/usage.ts`) — no platform concept exists anywhere in the schema. A "platform usage" view could only mean either inventing data that doesn't exist or iterating every Organization's private usage from the Console, which is exactly the "tenant data browser" CLAUDE.md's Fase 15 brief rules out explicitly.

**No new migration.** Every Fase 15 addition reuses existing tables (`audit_logs`, `api_keys`) unchanged — only new `platform_permissions` rows (data, inserted by `npm run db:seed`, not a schema change) and new service/route code.

### Role assignment vs. role definition

Two different things are easy to conflate:

- **Role assignment** — "which role does this membership have?" Already existed (`PATCH .../memberships/:id` + `role.assign`), audited in this step (see above), tenant-isolated (a membership can only be reached through its own organization's route — cross-org membership IDs 404, not leak).
- **Role definition** — "what permissions does the `ADMIN` role grant?" (i.e. editing `role_permissions` itself). **Deliberately not built in this step.** There's no `role.manage` permission and no endpoint to mutate `role_permissions`. Reasoning: (1) there's no `PLATFORM_ADMIN` actor distinct from organization members yet — an `OWNER`/`ADMIN` role_permissions editor today could only be gated by an org-scoped permission, which would let an organization owner redefine what `ADMIN` means *platform-wide*, breaking the platform/organization boundary (see CLAUDE.md §11); (2) v1 only needs 4 fixed, platform-defined roles (§2 "global roles + global permissions", not custom roles). Revisit when a real platform-admin context exists (Console phase).

### Fase 16 — Production Readiness

"Funciona" → "está preparado para operar com segurança e previsibilidade." No new product functionality — hardening, environment isolation, observability foundations, and documentation for a real Development → Staging → Production progression. **No production deployment was performed in this phase.**

**Environment Strategy.** `APP_ENV` (`development`/`staging`/`production`) joins `NODE_ENV` — deliberately distinct, since staging and production both run `NODE_ENV=production` (for Node/library optimizations) but need their own identity for decisions `NODE_ENV` can't express. Config validation now refuses to boot `staging`/`production` with `PLATFORM_ALLOWED_ORIGINS` silently defaulted to `localhost:3000` — that default is `development`-only; a deployed environment must set it explicitly or the process exits before `app.listen`. No staging/production infrastructure has been provisioned — this is the config-level contract that infrastructure, when it exists, must satisfy.

**CORS.** Unchanged in mechanism from Fase 15 (explicit `PLATFORM_ALLOWED_ORIGINS` allow-list, never `*`), now with an environment-strategy backstop above. Verified live via `scripts/smoke.ts`: an allow-listed origin gets `Access-Control-Allow-Origin`; a disallowed one gets none (the browser, not the server, is what actually blocks a disallowed origin — a non-browser caller still receives a normal response, just without that header).

**Security headers.** `helmet()` (unchanged, already applied broadly). No Content-Security-Policy added — out of scope until a browser client that needs one exists on this side (the API returns JSON, not HTML). UL Console's own headers are documented in its README.

**Request ID (`middleware/requestId.ts`).** Every request gets a `requestId` — a validated client-supplied `X-Request-ID` (`^[A-Za-z0-9._-]{1,128}$`) if present, otherwise a fresh UUID — set before any other middleware runs. Echoed on the `X-Request-ID` response header (never in the `{data}`/`{error}` JSON body — that contract doesn't change) and attached to every structured log line for that request. `cors()`'s `exposedHeaders` lets a browser's own JS read it back.

**Structured logging (`shared/logger.ts`).** JSON lines to stdout/stderr — `{timestamp, level, environment, message, ...fields}` — no external shipper yet, just a machine-parseable foundation one can be pointed at later without rewriting call sites. `logger.debug` is silenced when `NODE_ENV=production` (health-check request-completed lines log at `debug`, so routine polling doesn't drown real traffic at `info`). Discipline, not type-enforced: never log a JWT, API key secret, webhook secret, password, or a `DATABASE_URL`/connection string.

**Error handling.** The response contract is unchanged and identical in every environment — `errorHandler` never sent a stack trace, SQL, or credential to the client even before this phase; that was already correct. What changed: every branch now also emits a structured log line (`http.request.error` at `info` for expected 4xx outcomes, `error` with the full stack for a genuine 500), keyed by `requestId` so a generic client-facing message can still be correlated with the real cause server-side.

**Health / Readiness (`GET /v1/health`, `GET /v1/health/ready`).** Split on purpose: liveness (`/health`) has zero dependencies — if PostgreSQL is down, it must still answer `200`, because a liveness probe that depends on a downstream service causes an orchestrator to kill and restart a perfectly healthy process instead of just routing traffic away from it. Readiness (`/health/ready`) runs `select 1` and returns `503` (never host/connection-string/driver detail) if the database isn't reachable — verified live that its response never mentions `supabase.co` or `postgres://`.

**Graceful shutdown (`server.ts`).** `SIGTERM`/`SIGINT` now: stop accepting new connections (`server.close()`) → let in-flight requests finish → close the DB pool (`queryClient.end({ timeout: 5 })`) → exit, with a 10s hard ceiling (`process.exit(1)`) so a stuck connection can never hang the process indefinitely.

**Database pool.** Unchanged from Fase 15 (`max: 5, idle_timeout: 20`) — already sized for Supabase's pooler (pgbouncer session mode) rather than an arbitrary guess; now explicitly torn down on shutdown instead of left dangling.

**JWT/JWKS.** `verifySupabaseAccessToken` now also validates `issuer` (`${SUPABASE_URL}/auth/v1`) on both the HS256 and ES256/JWKS paths — the signature check alone already scopes acceptance to this project's own keys/secret, but `issuer` is explicit defense in depth and gives a token from a *different* Supabase project a clearer rejection reason than an opaque signature mismatch. `createRemoteJWKSet` already caches/rotates by `kid` (no per-request JWKS network call). Audience, expiration and algorithm were already checked — see `tests/jwt-verification.test.ts` for invalid-signature/expired/wrong-issuer/wrong-audience/malformed/missing-claim coverage.

**Platform Credentials.** Reviewed against Fase 15's own implementation — still correct: `GET` never returns a secret, audit metadata never contains one (tested explicitly), and `WEBHOOK_SECRET_ENCRYPTION_KEY` comes only from the environment, never persisted to the database. No changes needed.

**API Key security.** Reviewed `modules/apiKeys/crypto.ts` — already using `timingSafeEqual` for constant-time secret comparison, SHA-256 over a 256-bit CSPRNG secret (deliberately not a password-style KDF — see the file's own comment for why), and the raw secret is never stored, only its hash. No changes needed.

**Audit query performance.** Three indexes added, matching `listPlatformAuditLogs`'s actual query shape, not indiscriminately: `(created_at desc, id desc)` for the keyset-pagination ORDER BY (used on every call), `action` for the control-plane prefix allowlist plus the exact-action filter, `actor_user_id` for that filter param. `target_type`/`target_id` stay unindexed — always used alongside another condition, never proven as a standalone bottleneck.

**Rate limiting (`middleware/rateLimit.ts`).** A minimal in-memory, per-process limiter — deliberately not Redis-backed; this is a single-instance deployment and a distributed limiter would be complexity with no present payoff (documented limitation: a multi-instance deployment would need a real fix here). Applied to the operations this phase names as priority: `POST /platform/credentials` (10/5min), `POST /platform/credentials/:id/revoke` (20/5min), `POST .../webhooks/:id/test` (10/min), `GET /service/discover` (60/min). Keyed by authenticated identity when known (survives IP changes/shared NATs), falling back to IP. Deliberately **not** applied to health endpoints — rate-limiting legitimate load-balancer/orchestrator polling risks a false "unhealthy" cascade.

**Migration strategy.** Unchanged and already correct: versioned migrations via `drizzle-kit generate`/`migrate` (10 migrations so far, `drizzle/migrations/`), never `db:push` as the production mechanism (that script remains a local-iteration convenience only). Staging and production should each run `npm run db:migrate` explicitly and auditably — never automatically on deploy without a human trigger.

**Seed strategy.** Unchanged and already correct: `npm run db:seed` seeds only platform-defined catalogs (roles, permissions, applications, plans, scopes, meters — all idempotent `onConflictDoUpdate`), never a tenant or an administrator. `npm run platform:bootstrap-admin` remains a separate, explicit, one-time operator action — never automatic on startup.

**CI (`.github/workflows/ci.yml`).** New. `install → lint → typecheck → migrate → seed → test → smoke → build` against an ephemeral `postgres:16` service container. No deployment step. The `SUPABASE_*`/`DATABASE_URL` values in the workflow are fixed, non-secret fixtures scoped to that disposable container — never a real Supabase project, never something staging or production credentials could be confused with.

**Staging.** Not provisioned. What staging needs, concretely, when it's created: a dedicated Supabase project (own Auth users, own JWT signing keys — never shared with production or development), a dedicated PostgreSQL database, `APP_ENV=staging`/`NODE_ENV=production`, `PLATFORM_ALLOWED_ORIGINS` set to the staging Console's real origin, `npm run db:migrate` run explicitly against it, and its own `platform:bootstrap-admin` run once. No URL is assumed or invented here.

**Production checklist** (nothing below has been executed): dedicated Supabase project + PostgreSQL database (never staging's or development's), `APP_ENV=production`/`NODE_ENV=production`, every required secret set (`DATABASE_URL`, `SUPABASE_*`, `WEBHOOK_SECRET_ENCRYPTION_KEY`) and none committed, `PLATFORM_ALLOWED_ORIGINS` set to the real Console production origin only, `npm run db:migrate` run explicitly and auditably, `platform:bootstrap-admin` run once for the first real administrator, `/v1/health` and `/v1/health/ready` reachable by whatever orchestrator/load balancer is chosen, logs routed somewhere durable.

**Deliberately not implemented this phase:** automatic production deployment, Docker/Kubernetes orchestration, Redis, Kafka, a distributed rate limiter, a full observability stack (Grafana/Prometheus/Loki/Jaeger/OpenTelemetry), DNS/domain automation. See CLAUDE.md's Fase 16 brief §48 for the complete list — the foundation laid here (structured logs, request IDs, health/readiness) is meant to make adding those tools later additive, not a rewrite.
