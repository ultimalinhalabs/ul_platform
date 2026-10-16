CREATE TABLE "organization_creation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_creation_requests_key_check" CHECK (length("organization_creation_requests"."idempotency_key") between 8 and 200)
);
--> statement-breakpoint
ALTER TABLE "organization_creation_requests" ADD CONSTRAINT "organization_creation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_creation_requests" ADD CONSTRAINT "organization_creation_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_creation_requests_key_unique" ON "organization_creation_requests" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "organizations_created_by_created_at_idx" ON "organizations" USING btree ("created_by","created_at");--> statement-breakpoint
-- Server-side only: closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "organization_creation_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."organization_creation_requests" FROM %I', r);
    END IF;
  END LOOP;
END $$;
