-- Owner decision 2026-10-18: commercial terms are approved from the UL Console by a platform member holding
-- `platform.terms.approve` (exact text by SHA-256, audited, irreversible — the 0016 trigger freezes an approved text).
-- Catalog data only (idempotent; mirrors db/seed/data.ts). PLATFORM_ADMIN keeps every permission.
INSERT INTO "platform_permissions" ("key", "description") VALUES
  ('platform.terms.approve', 'Approve a draft commercial terms text (exact text by SHA-256; audited; irreversible).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.terms.approve'
ON CONFLICT DO NOTHING;
