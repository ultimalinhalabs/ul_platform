CREATE TABLE "commercial_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"correlation_id" text,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_events_aggregate_type_check" CHECK ("commercial_events"."aggregate_type" in ('terms_template', 'proposal', 'proposal_version', 'proposal_access_link', 'proposal_acceptance', 'contract', 'contract_version', 'entitlement_grant')),
	CONSTRAINT "commercial_events_actor_type_check" CHECK ("commercial_events"."actor_type" in ('user', 'platform_admin', 'public_link', 'system')),
	CONSTRAINT "commercial_events_event_type_check" CHECK ("commercial_events"."event_type" ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "commercial_events_actor_user_check" CHECK ("commercial_events"."actor_type" not in ('user', 'platform_admin') or "commercial_events"."actor_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "commercial_terms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_terms_templates_key_version_unique" UNIQUE("key","version"),
	CONSTRAINT "commercial_terms_templates_status_check" CHECK ("commercial_terms_templates"."status" in ('draft', 'approved', 'retired')),
	CONSTRAINT "commercial_terms_templates_version_check" CHECK ("commercial_terms_templates"."version" > 0),
	CONSTRAINT "commercial_terms_templates_key_check" CHECK ("commercial_terms_templates"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "commercial_terms_templates_sha_check" CHECK ("commercial_terms_templates"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "commercial_terms_templates_approval_check" CHECK ("commercial_terms_templates"."status" = 'draft' or ("commercial_terms_templates"."approved_by" is not null and "commercial_terms_templates"."approved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "commercial_events" ADD CONSTRAINT "commercial_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_events" ADD CONSTRAINT "commercial_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_terms_templates" ADD CONSTRAINT "commercial_terms_templates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_terms_templates" ADD CONSTRAINT "commercial_terms_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_events_aggregate_idx" ON "commercial_events" USING btree ("aggregate_type","aggregate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "commercial_events_event_type_idx" ON "commercial_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "commercial_events_organization_idx" ON "commercial_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_events_idempotency_unique" ON "commercial_events" USING btree ("idempotency_key") WHERE "commercial_events"."idempotency_key" is not null;
--> statement-breakpoint
-- Block 1A — shared guards of the commercial history (SQLSTATE UL001 = immutable commercial record).
CREATE OR REPLACE FUNCTION "public"."commercial_forbid_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial record is immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'UL001';
END $$;
--> statement-breakpoint
CREATE TRIGGER "commercial_events_append_only" BEFORE UPDATE OR DELETE ON "commercial_events" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "commercial_events_no_truncate" BEFORE TRUNCATE ON "commercial_events" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Terms: body_sha256 must be sha256(body); once approved, content is frozen (approved -> retired is the only change); only drafts can be deleted.
CREATE OR REPLACE FUNCTION "public"."commercial_terms_templates_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'commercial record is immutable: approved/retired terms cannot be deleted' USING ERRCODE = 'UL001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.body_sha256 <> encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'body_sha256 does not match sha256(body)' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - ARRAY['status', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at'])
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'commercial record is immutable: % terms cannot change (only approved -> retired)', OLD.status USING ERRCODE = 'UL001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "commercial_terms_templates_guard" BEFORE INSERT OR UPDATE OR DELETE ON "commercial_terms_templates" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_terms_templates_guard"();--> statement-breakpoint
CREATE TRIGGER "commercial_terms_templates_no_truncate" BEFORE TRUNCATE ON "commercial_terms_templates" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "commercial_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_terms_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."commercial_events", "public"."commercial_terms_templates" FROM %I', r);
    END IF;
  END LOOP;
END $$;
