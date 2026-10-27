-- Interface credential (Na Pista, 2026-10-27): create-only scopes for a customer-facing interface's server-side key.
-- `order.create` creates orders without confirming/canceling them or reading the organization's orders (Na Pista lets
-- such a key read only the orders it created); `customer.create` creates customers without reading them.
-- Reference data only, idempotent; mirrors db/seed/data.ts. Allowed to NA_PISTA only. No existing key is changed.
INSERT INTO "service_scopes" ("key", "description") VALUES
  ('order.create', 'Create orders only (no confirm/cancel, no listing; Na Pista: read back only the orders this key created).'),
  ('customer.create', 'Create customers only (no reading or changing them).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "application_service_scopes" ("application_id", "service_scope_id")
SELECT a."id", s."id" FROM "applications" a, "service_scopes" s
WHERE a."key" = 'NA_PISTA' AND s."key" IN ('order.create', 'customer.create')
ON CONFLICT DO NOTHING;
