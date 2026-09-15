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
tests/           node:test suite (database/seed, authorization, identity, customer, organizations, memberships)
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
