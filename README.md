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
                 roles/permissions catalog, role-assignment security, applications catalog, plans/plan entitlements)
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

### Applications are a registry, not a module boundary

An `Application` row (e.g. `NA_PISTA`) means "the platform knows this product exists" — it is never where that product's business logic (catalog, orders, wallet, delivery, ...) lives; that stays in the product's own independent repository. It also does **not** mean an Organization has commercial access to it — that will be `Organization → Subscription → Plan → Entitlement` (not built yet). `applications.status` (`ACTIVE`/`SUSPENDED`/`DEPRECATED`, default `ACTIVE`) exists so an application can stop accepting new subscriptions or be retired without a physical delete — necessary because `plans.applicationId` is `ON DELETE RESTRICT`, so once an application has any plans, Postgres itself refuses to delete it; `status` covers the lifecycle *before* that FK protection would apply. No product-specific permissions (e.g. `na_pista.catalog.read`) and no `organization_applications` table were added — those belong to the future Subscription model or to the products themselves.

### Application → Plan → Entitlement (and what it is not)

```
Application ("NA_PISTA" — what product is this?)
   └── Plan ("BUSINESS" — which commercial offer of that product?)
         └── Plan Entitlement ("products.max" = 1000 — what does that offer include?)
```

Three distinctions that are easy to blur:

- **Entitlement ≠ Permission.** A `Permission` (e.g. `membership.create`) answers "what can this *actor* do?" and lives on `Role → Permission → Membership`. An `Entitlement` (e.g. `products.max = 1000`) answers "what capability/limit does this *commercial offer* include?" and lives on `Plan → Plan Entitlement`. They are unrelated tables serving unrelated questions — entitlements are never granted through the permission system, and permissions are never plan-scoped.
- **Plan ≠ Subscription.** A `Plan` is a standing offer ("Business exists and includes these entitlements"); nothing about it implies any Organization has it. `Organization → Subscription → Plan` (not built yet) is what will establish that. No `organization_id` appears anywhere in `plans` or `plan_entitlements`.
- **Application ≠ Organization access.** An `Application` existing (e.g. `NA_PISTA`) doesn't mean every Organization can use it — that commercial relationship is exactly what Subscription will resolve. This step only registers the offer, not who has it.

`plan_entitlements` has no separate "entitlement definitions" catalog table (unlike `permissions`, which backs `role_permissions`): entitlement keys are not a fixed platform vocabulary the way permissions are — products define their own capability keys (`catalog.enabled`, `products.max`, ...) as needed, and a global definitions table would either sit empty or tempt the platform into knowing product-specific semantics it must not know (see CLAUDE.md §10). A `plan_entitlements` row belongs to exactly one plan, and a plan belongs to exactly one application, so a `NA_PISTA` plan cannot end up carrying a `micha_express.*`-style key by cross-referencing a shared table — there is no shared table to cross-reference. `value` is `jsonb` (same choice already made for the future `entitlements` table) so booleans, integers and short strings are all representable without a separate type column.

`entitlements` (already in the schema, still unused) is a *different* table for a *later* step: it resolves what a specific Organization actually has (via a Subscription), not what a Plan defines. Do not conflate the two — `plan_entitlements` is the offer's definition, `entitlements` will be the resolved grant.

### Role assignment vs. role definition

Two different things are easy to conflate:

- **Role assignment** — "which role does this membership have?" Already existed (`PATCH .../memberships/:id` + `role.assign`), audited in this step (see above), tenant-isolated (a membership can only be reached through its own organization's route — cross-org membership IDs 404, not leak).
- **Role definition** — "what permissions does the `ADMIN` role grant?" (i.e. editing `role_permissions` itself). **Deliberately not built in this step.** There's no `role.manage` permission and no endpoint to mutate `role_permissions`. Reasoning: (1) there's no `PLATFORM_ADMIN` actor distinct from organization members yet — an `OWNER`/`ADMIN` role_permissions editor today could only be gated by an org-scoped permission, which would let an organization owner redefine what `ADMIN` means *platform-wide*, breaking the platform/organization boundary (see CLAUDE.md §11); (2) v1 only needs 4 fixed, platform-defined roles (§2 "global roles + global permissions", not custom roles). Revisit when a real platform-admin context exists (Console phase).
