-- Audit 2026-10-23 (Na Pista credentials): service scopes per personal-data resource, so a Na Pista integration key
-- no longer needs `catalog.*` to reach customers, orders or appointments. Reference data only, idempotent; mirrors
-- db/seed/data.ts. `customer.read` already exists (and is already allowed to NA_PISTA). No existing key is changed.
INSERT INTO "service_scopes" ("key", "description") VALUES
  ('customer.write', 'Create, update or archive customer data.'),
  ('order.read', 'Read orders.'),
  ('order.write', 'Create orders and change their items or lifecycle.'),
  ('appointment.read', 'Read appointments.'),
  ('appointment.write', 'Book appointments and change their schedule or lifecycle.')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "application_service_scopes" ("application_id", "service_scope_id")
SELECT a."id", s."id" FROM "applications" a, "service_scopes" s
WHERE a."key" = 'NA_PISTA' AND s."key" IN ('customer.write', 'order.read', 'order.write', 'appointment.read', 'appointment.write')
ON CONFLICT DO NOTHING;
