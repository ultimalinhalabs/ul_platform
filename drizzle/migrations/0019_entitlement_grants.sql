CREATE TABLE "entitlement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"contract_item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"plan_id" uuid,
	"entitlements_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL,
	"subscription_id" uuid,
	"application_access_id" uuid,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_grants_contract_item_unique" UNIQUE("contract_item_id"),
	CONSTRAINT "entitlement_grants_status_check" CHECK ("entitlement_grants"."status" in ('planned', 'active', 'expired', 'revoked')),
	CONSTRAINT "entitlement_grants_period_check" CHECK ("entitlement_grants"."ends_at" is null or "entitlement_grants"."starts_at" is null or "entitlement_grants"."ends_at" > "entitlement_grants"."starts_at"),
	CONSTRAINT "entitlement_grants_activation_check" CHECK ("entitlement_grants"."status" = 'planned' or ("entitlement_grants"."activated_at" is not null and "entitlement_grants"."activated_by" is not null) or "entitlement_grants"."status" = 'revoked'),
	CONSTRAINT "entitlement_grants_active_links_check" CHECK ("entitlement_grants"."status" <> 'active' or "entitlement_grants"."subscription_id" is not null),
	CONSTRAINT "entitlement_grants_revoked_check" CHECK ("entitlement_grants"."status" <> 'revoked' or ("entitlement_grants"."revoked_at" is not null and "entitlement_grants"."revoked_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."contract_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_application_access_id_organization_application_access_id_fk" FOREIGN KEY ("application_access_id") REFERENCES "public"."organization_application_access"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_one_active_per_app" ON "entitlement_grants" USING btree ("organization_id","application_id") WHERE "entitlement_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX "entitlement_grants_contract_idx" ON "entitlement_grants" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "entitlement_grants_organization_idx" ON "entitlement_grants" USING btree ("organization_id","status");--> statement-breakpoint
-- Block 1A — grants are history: never deleted; their identity is fixed; the item must belong to the contract and the organization
-- must be the contract's; status only moves planned -> active | revoked, active -> expired | revoked (expired/revoked are final).
CREATE OR REPLACE FUNCTION "public"."entitlement_grants_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: entitlement grants cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'planned' THEN
      RAISE EXCEPTION 'an entitlement grant must be created as planned' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "public"."contract_items" ci JOIN "public"."contract_versions" cv ON cv.id = ci.contract_version_id
      JOIN "public"."contracts" c ON c.id = cv.contract_id
      WHERE ci.id = NEW.contract_item_id AND c.id = NEW.contract_id AND c.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'grant item/organization does not match the contract' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.contract_item_id IS DISTINCT FROM OLD.contract_item_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.entitlements_snapshot IS DISTINCT FROM OLD.entitlements_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'commercial record is immutable: entitlement grant identity cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF NOT (NEW.status = OLD.status
          OR (OLD.status = 'planned' AND NEW.status IN ('active', 'revoked'))
          OR (OLD.status = 'active' AND NEW.status IN ('expired', 'revoked'))) THEN
    RAISE EXCEPTION 'invalid entitlement grant transition % -> %', OLD.status, NEW.status USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status IN ('expired', 'revoked') AND (to_jsonb(NEW) - ARRAY['updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'commercial record is immutable: % grants are final', OLD.status USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "entitlement_grants_guard" BEFORE INSERT OR UPDATE OR DELETE ON "entitlement_grants" FOR EACH ROW EXECUTE FUNCTION "public"."entitlement_grants_guard"();--> statement-breakpoint
CREATE TRIGGER "entitlement_grants_no_truncate" BEFORE TRUNCATE ON "entitlement_grants" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
ALTER TABLE "entitlement_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."entitlement_grants" FROM %I', r);
    END IF;
  END LOOP;
END $$;