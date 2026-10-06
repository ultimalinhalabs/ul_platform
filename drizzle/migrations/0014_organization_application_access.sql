CREATE TABLE "organization_application_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"granted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_application_access_status_check" CHECK ("organization_application_access"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "organization_application_access" ADD CONSTRAINT "organization_application_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_application_access" ADD CONSTRAINT "organization_application_access_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_application_access" ADD CONSTRAINT "organization_application_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_application_access_org_app_unique" ON "organization_application_access" USING btree ("organization_id","application_id");--> statement-breakpoint
-- Fase 6 catalog data (idempotent; no-op on a fresh database before seeding).
INSERT INTO "platform_permissions" ("key", "description") VALUES ('platform.application_access.manage', 'Grant/revoke an organization''s access to an application (separate from billing).') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.application_access.manage'
ON CONFLICT DO NOTHING;
