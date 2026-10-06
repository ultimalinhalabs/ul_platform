CREATE TABLE "application_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_roles_application_key_unique" UNIQUE("application_id","key")
);
--> statement-breakpoint
CREATE TABLE "membership_application_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_roles" ADD CONSTRAINT "application_roles_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_application_roles" ADD CONSTRAINT "membership_application_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_application_roles" ADD CONSTRAINT "membership_application_roles_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_application_roles" ADD CONSTRAINT "membership_application_roles_role_fk" FOREIGN KEY ("application_id","role_key") REFERENCES "public"."application_roles"("application_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_application_roles_membership_application_unique" ON "membership_application_roles" USING btree ("membership_id","application_id");--> statement-breakpoint
-- Fase 6 catalog data: each application's own roles (idempotent; no-op before applications are seeded).
INSERT INTO "application_roles" ("application_id", "key", "name", "description")
SELECT a."id", v."key", v."name", v."description"
FROM "applications" a
JOIN (VALUES
  ('QUALE_A_DICA', 'OWNER', 'Owner', 'Full control of the organization inside Qualé a Dica.'),
  ('QUALE_A_DICA', 'ADMIN', 'Admin', 'Manages channels, automation and agents inside Qualé a Dica.'),
  ('QUALE_A_DICA', 'AGENT', 'Agent', 'Handles conversations inside Qualé a Dica.'),
  ('NA_PISTA', 'OWNER', 'Owner', 'Full control of the organization inside Na Pista.'),
  ('NA_PISTA', 'ADMIN', 'Admin', 'Manages the catalog and operations inside Na Pista.'),
  ('NA_PISTA', 'MANAGER', 'Manager', 'Operational management inside Na Pista.'),
  ('NA_PISTA', 'STAFF', 'Staff', 'Baseline operational access inside Na Pista.')
) AS v("app_key", "key", "name", "description") ON a."key" = v."app_key"
ON CONFLICT ("application_id", "key") DO NOTHING;
