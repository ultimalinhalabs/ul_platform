CREATE TABLE "commercial_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_application_id" uuid NOT NULL,
	"created_by_api_key_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"business_area" text NOT NULL,
	"desired_service" text NOT NULL,
	"message" text NOT NULL,
	"landing_page" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_leads_status_check" CHECK ("commercial_leads"."status" in ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST')),
	CONSTRAINT "commercial_leads_idempotency_check" CHECK (length("commercial_leads"."idempotency_key") between 8 and 200)
);
--> statement-breakpoint
ALTER TABLE "commercial_leads" ADD CONSTRAINT "commercial_leads_source_application_id_applications_id_fk" FOREIGN KEY ("source_application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_leads" ADD CONSTRAINT "commercial_leads_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_leads_idempotency_unique" ON "commercial_leads" USING btree ("source_application_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "commercial_leads_created_at_idx" ON "commercial_leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "commercial_leads_email_idx" ON "commercial_leads" USING btree ("email");--> statement-breakpoint
-- Personal data: closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "commercial_leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."commercial_leads" FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- The UL landing page as a registered consumer (catalog data, idempotent; mirrors db/seed/data.ts).
INSERT INTO "applications" ("key", "name", "description") VALUES
  ('UL_LANDING', 'Landing Última Linha', 'Public website of Última Linha (ultimalinha.ao); submits commercial contact requests.')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "service_scopes" ("key", "description") VALUES
  ('lead.create', 'Submit a commercial contact request (lead) addressed to Última Linha.')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "application_service_scopes" ("application_id", "service_scope_id")
SELECT a."id", s."id" FROM "applications" a, "service_scopes" s
WHERE a."key" = 'UL_LANDING' AND s."key" = 'lead.create'
ON CONFLICT DO NOTHING;
