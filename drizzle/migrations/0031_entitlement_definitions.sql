CREATE TABLE "entitlement_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_type" text NOT NULL,
	"module" text,
	"requires" text[] DEFAULT '{}'::text[] NOT NULL,
	"absent_policy" text DEFAULT 'deny' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_definitions_app_key_unique" UNIQUE("application_id","key"),
	CONSTRAINT "entitlement_definitions_key_check" CHECK ("entitlement_definitions"."key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "entitlement_definitions_value_type_check" CHECK ("entitlement_definitions"."value_type" in ('boolean', 'limit')),
	CONSTRAINT "entitlement_definitions_absent_policy_check" CHECK ("entitlement_definitions"."absent_policy" in ('deny', 'unlimited') and ("entitlement_definitions"."value_type" = 'limit' or "entitlement_definitions"."absent_policy" = 'deny')),
	CONSTRAINT "entitlement_definitions_status_check" CHECK ("entitlement_definitions"."status" in ('active', 'deprecated'))
);
--> statement-breakpoint
CREATE TABLE "grant_entitlement_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'plan' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_entitlement_values_grant_key_unique" UNIQUE("grant_id","key"),
	CONSTRAINT "grant_entitlement_values_source_check" CHECK ("grant_entitlement_values"."source" in ('plan', 'addon', 'override'))
);
--> statement-breakpoint
CREATE TABLE "plan_entitlement_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"actor" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_entitlement_history_operation_check" CHECK ("plan_entitlement_history"."operation" in ('insert', 'update', 'delete'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "entitlement_definitions" ADD CONSTRAINT "entitlement_definitions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_entitlement_values" ADD CONSTRAINT "grant_entitlement_values_grant_id_entitlement_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."entitlement_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_entitlement_history_plan_idx" ON "plan_entitlement_history" USING btree ("plan_id","changed_at");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_origin_check" CHECK ("subscriptions"."origin" is null or "subscriptions"."origin" in ('commercial', 'demo', 'test', 'legacy'));--> statement-breakpoint
-- Audit 2026-10-20 — every change to a plan's commercial values is recorded, whatever wrote it (seed, loader, SQL).
CREATE OR REPLACE FUNCTION "public"."plan_entitlements_history"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE who text := coalesce(nullif(current_setting('ul.actor', true), ''), current_user);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "public"."plan_entitlement_history" ("plan_id", "key", "operation", "old_value", "new_value", "actor") VALUES (NEW.plan_id, NEW.key, 'insert', NULL, NEW.value, who);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.value IS DISTINCT FROM OLD.value OR NEW.key IS DISTINCT FROM OLD.key OR NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
      INSERT INTO "public"."plan_entitlement_history" ("plan_id", "key", "operation", "old_value", "new_value", "actor") VALUES (NEW.plan_id, NEW.key, 'update', OLD.value, NEW.value, who);
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO "public"."plan_entitlement_history" ("plan_id", "key", "operation", "old_value", "new_value", "actor") VALUES (OLD.plan_id, OLD.key, 'delete', OLD.value, NULL, who);
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "plan_entitlements_history" AFTER INSERT OR UPDATE OR DELETE ON "plan_entitlements" FOR EACH ROW EXECUTE FUNCTION "public"."plan_entitlements_history"();--> statement-breakpoint
CREATE TRIGGER "plan_entitlement_history_append_only" BEFORE UPDATE OR DELETE ON "plan_entitlement_history" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "plan_entitlement_history_no_truncate" BEFORE TRUNCATE ON "plan_entitlement_history" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Frozen contract values: insert-only, and only for a grant that is still planned (activation) or active (backfill).
CREATE OR REPLACE FUNCTION "public"."grant_entitlement_values_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."entitlement_grants" g WHERE g.id = NEW.grant_id AND g.status IN ('planned', 'active')) THEN
    RAISE EXCEPTION 'entitlement values can only be frozen for a planned or active grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "grant_entitlement_values_guard" BEFORE INSERT ON "grant_entitlement_values" FOR EACH ROW EXECUTE FUNCTION "public"."grant_entitlement_values_guard"();--> statement-breakpoint
CREATE TRIGGER "grant_entitlement_values_append_only" BEFORE UPDATE OR DELETE ON "grant_entitlement_values" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "grant_entitlement_values_no_truncate" BEFORE TRUNCATE ON "grant_entitlement_values" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants), like 0015+.
ALTER TABLE "entitlement_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_entitlement_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_entitlement_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['entitlement_definitions', 'grant_entitlement_values', 'plan_entitlement_history'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE "public".%I FROM %I', t, r);
      END LOOP;
      EXECUTE format('REVOKE ALL ON FUNCTION "public"."plan_entitlements_history"() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION "public"."grant_entitlement_values_guard"() FROM %I', r);
    END IF;
  END LOOP;
END $$;
