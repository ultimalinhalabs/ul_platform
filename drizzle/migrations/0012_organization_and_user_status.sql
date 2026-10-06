ALTER TABLE "organizations" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'suspended'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'disabled'));--> statement-breakpoint
-- Fase 6 catalog data (idempotent; no-op on a fresh database before seeding).
INSERT INTO "platform_permissions" ("key", "description") VALUES ('platform.organization.manage', 'Suspend/reactivate organizations (organizations.status).') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.organization.manage'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Fase 6 catalog data (idempotent; no-op on a fresh database before seeding).
INSERT INTO "platform_permissions" ("key", "description") VALUES ('platform.user.manage', 'Disable/reactivate platform users (users.status).') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.user.manage'
ON CONFLICT DO NOTHING;
