# UL Platform

Shared infrastructure layer for the Última Linha ecosystem: identity, organizations,
memberships, roles/permissions, applications, plans/subscriptions, entitlements,
customers and audit. It is not a container for product business logic — see
`../docs/UL_PLATFORM_CONTEXT_V1.md` and this repo's own architectural rules.

## Stack

Node.js, TypeScript, Express, PostgreSQL (Drizzle ORM), Supabase Auth, Zod.

## Getting started

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and Supabase project values
npm run db:generate     # generate SQL migrations from src/db/schema
npm run db:migrate       # apply migrations to DATABASE_URL
npm run dev
```

## Scripts

- `npm run dev` — run the API with hot reload
- `npm run build` / `npm start` — production build and run
- `npm run typecheck` / `npm run lint`
- `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` — Drizzle Kit

## Structure

```
src/
  config/        env loading & validation
  db/            drizzle client + schema/ (one file per domain)
  integrations/  external providers (supabase)
  middleware/    authenticate, organization context, permission checks, errors
  modules/       domain services (users, memberships, authorization, audit, ...)
  routes/v1/     versioned HTTP routes
  shared/        cross-cutting types/helpers (errors, response envelope)
```
