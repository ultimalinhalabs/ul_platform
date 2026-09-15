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
npm run db:seed        # idempotent: applications, roles, permissions, role_permissions
npm run dev
```

## Scripts

- `npm run dev` — run the API with hot reload
- `npm run build` / `npm start` — production build and run
- `npm run typecheck` / `npm run lint` / `npm test`
- `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` — Drizzle Kit
- `npm run db:seed` — idempotent seed of the platform catalogs (applications, roles, permissions)
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
                 roles/permissions catalog, role-assignment security, applications catalog)
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

### Applications are a registry, not a module boundary

An `Application` row (e.g. `NA_PISTA`) means "the platform knows this product exists" — it is never where that product's business logic (catalog, orders, wallet, delivery, ...) lives; that stays in the product's own independent repository. It also does **not** mean an Organization has commercial access to it — that will be `Organization → Subscription → Plan → Entitlement` (not built yet). `applications.status` (`ACTIVE`/`SUSPENDED`/`DEPRECATED`, default `ACTIVE`) exists so an application can stop accepting new subscriptions or be retired without a physical delete — necessary because `plans.applicationId` is `ON DELETE RESTRICT`, so once an application has any plans, Postgres itself refuses to delete it; `status` covers the lifecycle *before* that FK protection would apply. No product-specific permissions (e.g. `na_pista.catalog.read`) and no `organization_applications` table were added — those belong to the future Subscription model or to the products themselves.

### Role assignment vs. role definition

Two different things are easy to conflate:

- **Role assignment** — "which role does this membership have?" Already existed (`PATCH .../memberships/:id` + `role.assign`), audited in this step (see above), tenant-isolated (a membership can only be reached through its own organization's route — cross-org membership IDs 404, not leak).
- **Role definition** — "what permissions does the `ADMIN` role grant?" (i.e. editing `role_permissions` itself). **Deliberately not built in this step.** There's no `role.manage` permission and no endpoint to mutate `role_permissions`. Reasoning: (1) there's no `PLATFORM_ADMIN` actor distinct from organization members yet — an `OWNER`/`ADMIN` role_permissions editor today could only be gated by an org-scoped permission, which would let an organization owner redefine what `ADMIN` means *platform-wide*, breaking the platform/organization boundary (see CLAUDE.md §11); (2) v1 only needs 4 fixed, platform-defined roles (§2 "global roles + global permissions", not custom roles). Revisit when a real platform-admin context exists (Console phase).
