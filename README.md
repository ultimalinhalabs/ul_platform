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
- `npm run smoke` — live HTTP smoke test: starts the real app in-process and drives Service Scopes + Webhooks end to end (real bearer tokens, real API keys, a real local receiver verifying outbound signatures). Requires a migrated, seeded database; not part of `npm test`.

## Structure

```
src/
  config/        env loading & validation
  db/            drizzle client + schema/ (one file per domain) + seed/
  integrations/  external providers (supabase)
  middleware/    authenticate, organization context, permission checks, errors
  modules/       domain services (users, memberships, authorization, audit, ...)
  routes/v1/     versioned HTTP routes
  shared/        cross-cutting types/helpers (errors, response envelope)
scripts/         one-off/dev-only scripts (schema inspection, live HTTP smoke test)
tests/           node:test suite (database/seed, authorization, identity, customer, organizations, memberships,
                 roles/permissions catalog, role-assignment security, applications catalog, plans/plan entitlements,
                 subscriptions, organization application access, effective entitlement resolution, API keys,
                 service scopes, webhooks)
```

## API — v1

- `GET /v1/health` — liveness, no auth.
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
- `GET /v1/applications` / `GET /v1/applications/:applicationKey` — the platform's application registry (`UL_CONSOLE`, `NA_PISTA`, `MICHA_EXPRESS`, `FOI`, `QUALE_A_DICA`, `HOJE_TEM`). Read-only, auth-only — same reasoning as roles/permissions. Registering, activating or suspending an application is an administrative operation deferred to the future Console; there is no `POST`/`PATCH`/`DELETE` here.
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

### Role assignment vs. role definition

Two different things are easy to conflate:

- **Role assignment** — "which role does this membership have?" Already existed (`PATCH .../memberships/:id` + `role.assign`), audited in this step (see above), tenant-isolated (a membership can only be reached through its own organization's route — cross-org membership IDs 404, not leak).
- **Role definition** — "what permissions does the `ADMIN` role grant?" (i.e. editing `role_permissions` itself). **Deliberately not built in this step.** There's no `role.manage` permission and no endpoint to mutate `role_permissions`. Reasoning: (1) there's no `PLATFORM_ADMIN` actor distinct from organization members yet — an `OWNER`/`ADMIN` role_permissions editor today could only be gated by an org-scoped permission, which would let an organization owner redefine what `ADMIN` means *platform-wide*, breaking the platform/organization boundary (see CLAUDE.md §11); (2) v1 only needs 4 fixed, platform-defined roles (§2 "global roles + global permissions", not custom roles). Revisit when a real platform-admin context exists (Console phase).
