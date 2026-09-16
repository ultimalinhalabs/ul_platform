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
- `npm run db:seed` — idempotent seed of the platform catalogs (applications, roles, permissions, plans, plan entitlements)
- `npm run db:inspect` — dumps the live schema (tables/columns/constraints/FKs/indexes) for manual verification

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
scripts/         one-off/dev-only scripts (schema inspection)
tests/           node:test suite (database/seed, authorization, identity, customer, organizations, memberships,
                 roles/permissions catalog, role-assignment security, applications catalog, plans/plan entitlements,
                 subscriptions, organization application access, effective entitlement resolution, API keys)
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

### Role assignment vs. role definition

Two different things are easy to conflate:

- **Role assignment** — "which role does this membership have?" Already existed (`PATCH .../memberships/:id` + `role.assign`), audited in this step (see above), tenant-isolated (a membership can only be reached through its own organization's route — cross-org membership IDs 404, not leak).
- **Role definition** — "what permissions does the `ADMIN` role grant?" (i.e. editing `role_permissions` itself). **Deliberately not built in this step.** There's no `role.manage` permission and no endpoint to mutate `role_permissions`. Reasoning: (1) there's no `PLATFORM_ADMIN` actor distinct from organization members yet — an `OWNER`/`ADMIN` role_permissions editor today could only be gated by an org-scoped permission, which would let an organization owner redefine what `ADMIN` means *platform-wide*, breaking the platform/organization boundary (see CLAUDE.md §11); (2) v1 only needs 4 fixed, platform-defined roles (§2 "global roles + global permissions", not custom roles). Revisit when a real platform-admin context exists (Console phase).
