CREATE TABLE "contract_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_version_id" uuid NOT NULL,
	"source_proposal_item_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"application_id" uuid,
	"plan_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"line_total_minor" bigint NOT NULL,
	"billing_period" text NOT NULL,
	"duration_months" integer,
	"entitlement_spec" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_items_kind_check" CHECK ("contract_items"."kind" in ('application_plan', 'service', 'support', 'one_off', 'custom')),
	CONSTRAINT "contract_items_plan_check" CHECK ("contract_items"."kind" <> 'application_plan' or ("contract_items"."plan_id" is not null and "contract_items"."application_id" is not null)),
	CONSTRAINT "contract_items_quantity_check" CHECK ("contract_items"."quantity" > 0),
	CONSTRAINT "contract_items_unit_price_check" CHECK ("contract_items"."unit_price_minor" >= 0),
	CONSTRAINT "contract_items_line_total_check" CHECK ("contract_items"."line_total_minor" = "contract_items"."quantity"::bigint * "contract_items"."unit_price_minor"),
	CONSTRAINT "contract_items_billing_period_check" CHECK ("contract_items"."billing_period" in ('one_time', 'monthly', 'yearly')),
	CONSTRAINT "contract_items_duration_check" CHECK ("contract_items"."duration_months" is null or "contract_items"."duration_months" > 0),
	CONSTRAINT "contract_items_sort_check" CHECK ("contract_items"."sort" >= 0)
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"parties" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"terms_template_id" uuid NOT NULL,
	"terms_sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_contract_version_unique" UNIQUE("contract_id","version_no"),
	CONSTRAINT "contract_versions_version_no_check" CHECK ("contract_versions"."version_no" > 0),
	CONSTRAINT "contract_versions_content_sha_check" CHECK ("contract_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contract_versions_terms_sha_check" CHECK ("contract_versions"."terms_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_acceptance_id" uuid NOT NULL,
	"status" text DEFAULT 'pending_activation' NOT NULL,
	"current_version_id" uuid,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"renewal_policy" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_number_unique" UNIQUE("number"),
	CONSTRAINT "contracts_source_acceptance_unique" UNIQUE("source_acceptance_id"),
	CONSTRAINT "contracts_status_check" CHECK ("contracts"."status" in ('pending_activation', 'active', 'suspended', 'terminated', 'expired', 'cancelled')),
	CONSTRAINT "contracts_number_check" CHECK ("contracts"."number" ~ '^UL-C-[0-9]{4}-[0-9]{6,}$'),
	CONSTRAINT "contracts_currency_check" CHECK ("contracts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "contracts_total_check" CHECK ("contracts"."total_minor" >= 0),
	CONSTRAINT "contracts_period_check" CHECK ("contracts"."ends_at" is null or "contracts"."starts_at" is null or "contracts"."ends_at" > "contracts"."starts_at"),
	CONSTRAINT "contracts_renewal_policy_check" CHECK ("contracts"."renewal_policy" in ('none', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "proposal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"content_sha256" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"accepted_by_user_id" uuid NOT NULL,
	"signer_name" text NOT NULL,
	"signer_title" text,
	"signer_email" text NOT NULL,
	"terms_template_id" uuid NOT NULL,
	"consent_text" text NOT NULL,
	"consent_sha256" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"idempotency_key" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_acceptances_proposal_unique" UNIQUE("proposal_id"),
	CONSTRAINT "proposal_acceptances_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "proposal_acceptances_content_sha_check" CHECK ("proposal_acceptances"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "proposal_acceptances_consent_sha_check" CHECK ("proposal_acceptances"."consent_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "proposal_acceptances_signer_email_check" CHECK ("proposal_acceptances"."signer_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "proposal_acceptances_idempotency_check" CHECK (length("proposal_acceptances"."idempotency_key") between 8 and 200)
);
--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_contract_version_id_contract_versions_id_fk" FOREIGN KEY ("contract_version_id") REFERENCES "public"."contract_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_source_proposal_item_id_proposal_items_id_fk" FOREIGN KEY ("source_proposal_item_id") REFERENCES "public"."proposal_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_terms_template_id_commercial_terms_templates_id_fk" FOREIGN KEY ("terms_template_id") REFERENCES "public"."commercial_terms_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_source_acceptance_id_proposal_acceptances_id_fk" FOREIGN KEY ("source_acceptance_id") REFERENCES "public"."proposal_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_current_version_id_contract_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."contract_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_version_id_proposal_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_option_id_proposal_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."proposal_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ADD CONSTRAINT "proposal_acceptances_terms_template_id_commercial_terms_templates_id_fk" FOREIGN KEY ("terms_template_id") REFERENCES "public"."commercial_terms_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_items_version_idx" ON "contract_items" USING btree ("contract_version_id");--> statement-breakpoint
CREATE INDEX "contracts_organization_idx" ON "contracts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contracts_status_idx" ON "contracts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposal_acceptances_organization_idx" ON "proposal_acceptances" USING btree ("organization_id");--> statement-breakpoint
-- Block 1A — acceptance evidence: must point at the exact sent version/option/hash/terms; append-only afterwards.
CREATE OR REPLACE FUNCTION "public"."proposal_acceptances_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'commercial record is immutable: % on proposal_acceptances is not allowed', TG_OP USING ERRCODE = 'UL001';
  END IF;
  SELECT pv.proposal_id, pv.status, pv.content_sha256, pv.terms_template_id INTO v FROM "public"."proposal_versions" pv WHERE pv.id = NEW.version_id;
  IF v.proposal_id IS DISTINCT FROM NEW.proposal_id THEN
    RAISE EXCEPTION 'acceptance version does not belong to the proposal' USING ERRCODE = '23514';
  END IF;
  IF v.status <> 'sent' THEN
    RAISE EXCEPTION 'only the currently sent proposal version can be accepted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."proposal_options" o WHERE o.id = NEW.option_id AND o.version_id = NEW.version_id) THEN
    RAISE EXCEPTION 'acceptance option does not belong to the version' USING ERRCODE = '23514';
  END IF;
  IF NEW.content_sha256 IS DISTINCT FROM v.content_sha256 OR NEW.terms_template_id IS DISTINCT FROM v.terms_template_id THEN
    RAISE EXCEPTION 'acceptance content hash/terms do not match the sent version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposal_acceptances_guard" BEFORE INSERT OR UPDATE OR DELETE ON "proposal_acceptances" FOR EACH ROW EXECUTE FUNCTION "public"."proposal_acceptances_guard"();--> statement-breakpoint
CREATE TRIGGER "proposal_acceptances_no_truncate" BEFORE TRUNCATE ON "proposal_acceptances" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Contracts: never deleted; number/organization/source acceptance/currency/effective date are fixed; the organization must be the
-- accepting organization; current_version_id must belong to the contract.
CREATE OR REPLACE FUNCTION "public"."contracts_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: contracts cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.source_acceptance_id IS DISTINCT FROM OLD.source_acceptance_id OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'commercial record is immutable: contract identity cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "public"."proposal_acceptances" a WHERE a.id = NEW.source_acceptance_id AND a.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'contract organization must be the accepting organization' USING ERRCODE = '23514';
  END IF;
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."contract_versions" cv WHERE cv.id = NEW.current_version_id AND cv.contract_id = NEW.id) THEN
    RAISE EXCEPTION 'current_version_id does not belong to this contract' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "contracts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "contracts" FOR EACH ROW EXECUTE FUNCTION "public"."contracts_guard"();--> statement-breakpoint
CREATE TRIGGER "contracts_no_truncate" BEFORE TRUNCATE ON "contracts" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "contract_versions_append_only" BEFORE UPDATE OR DELETE ON "contract_versions" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "contract_versions_no_truncate" BEFORE TRUNCATE ON "contract_versions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "contract_items_append_only" BEFORE UPDATE OR DELETE ON "contract_items" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "contract_items_no_truncate" BEFORE TRUNCATE ON "contract_items" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
ALTER TABLE "proposal_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contract_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contract_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."proposal_acceptances", "public"."contracts", "public"."contract_versions", "public"."contract_items" FROM %I', r);
    END IF;
  END LOOP;
END $$;