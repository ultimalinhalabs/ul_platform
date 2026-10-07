CREATE TABLE "proposal_access_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"kind" text DEFAULT 'recipient' NOT NULL,
	"recipient_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_views" integer,
	"view_count" integer DEFAULT 0 NOT NULL,
	"first_viewed_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_access_links_token_unique" UNIQUE("token_sha256"),
	CONSTRAINT "proposal_access_links_token_check" CHECK ("proposal_access_links"."token_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "proposal_access_links_kind_check" CHECK ("proposal_access_links"."kind" in ('recipient', 'internal_preview')),
	CONSTRAINT "proposal_access_links_views_check" CHECK ("proposal_access_links"."view_count" >= 0 and ("proposal_access_links"."max_views" is null or "proposal_access_links"."max_views" > 0)),
	CONSTRAINT "proposal_access_links_expiry_check" CHECK ("proposal_access_links"."expires_at" > "proposal_access_links"."created_at"),
	CONSTRAINT "proposal_access_links_revoked_check" CHECK (("proposal_access_links"."revoked_at" is null) = ("proposal_access_links"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "proposal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"option_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"application_id" uuid,
	"plan_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"line_total_minor" bigint NOT NULL,
	"billing_period" text DEFAULT 'one_time' NOT NULL,
	"duration_months" integer,
	"entitlement_spec" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_items_kind_check" CHECK ("proposal_items"."kind" in ('application_plan', 'service', 'support', 'one_off', 'custom')),
	CONSTRAINT "proposal_items_plan_check" CHECK ("proposal_items"."kind" <> 'application_plan' or ("proposal_items"."plan_id" is not null and "proposal_items"."application_id" is not null)),
	CONSTRAINT "proposal_items_quantity_check" CHECK ("proposal_items"."quantity" > 0),
	CONSTRAINT "proposal_items_unit_price_check" CHECK ("proposal_items"."unit_price_minor" >= 0),
	CONSTRAINT "proposal_items_line_total_check" CHECK ("proposal_items"."line_total_minor" = "proposal_items"."quantity"::bigint * "proposal_items"."unit_price_minor"),
	CONSTRAINT "proposal_items_billing_period_check" CHECK ("proposal_items"."billing_period" in ('one_time', 'monthly', 'yearly')),
	CONSTRAINT "proposal_items_duration_check" CHECK ("proposal_items"."duration_months" is null or "proposal_items"."duration_months" > 0),
	CONSTRAINT "proposal_items_sort_check" CHECK ("proposal_items"."sort" >= 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_options_total_check" CHECK ("proposal_options"."total_minor" >= 0),
	CONSTRAINT "proposal_options_sort_check" CHECK ("proposal_options"."sort" >= 0)
);
--> statement-breakpoint
CREATE TABLE "proposal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text NOT NULL,
	"valid_until" timestamp with time zone,
	"summary" text,
	"notes" text,
	"terms_template_id" uuid,
	"snapshot" jsonb,
	"content_sha256" text,
	"hash_alg" text DEFAULT 'sha256-jcs-v1' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_versions_proposal_version_unique" UNIQUE("proposal_id","version_no"),
	CONSTRAINT "proposal_versions_status_check" CHECK ("proposal_versions"."status" in ('draft', 'sent', 'superseded', 'withdrawn')),
	CONSTRAINT "proposal_versions_version_no_check" CHECK ("proposal_versions"."version_no" > 0),
	CONSTRAINT "proposal_versions_currency_check" CHECK ("proposal_versions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "proposal_versions_hash_alg_check" CHECK ("proposal_versions"."hash_alg" in ('sha256-jcs-v1')),
	CONSTRAINT "proposal_versions_frozen_check" CHECK (("proposal_versions"."status" = 'draft' and "proposal_versions"."sent_at" is null and "proposal_versions"."snapshot" is null and "proposal_versions"."content_sha256" is null)
        or ("proposal_versions"."status" <> 'draft' and "proposal_versions"."sent_at" is not null and "proposal_versions"."sent_by" is not null and "proposal_versions"."snapshot" is not null
            and "proposal_versions"."content_sha256" ~ '^[0-9a-f]{64}$' and "proposal_versions"."terms_template_id" is not null and "proposal_versions"."valid_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"prospect_company_name" text NOT NULL,
	"prospect_tax_id" text,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"organization_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"current_version_id" uuid,
	"accepted_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_number_unique" UNIQUE("number"),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('draft', 'sent', 'viewed', 'negotiation', 'accepted', 'rejected', 'expired', 'withdrawn')),
	CONSTRAINT "proposals_number_check" CHECK ("proposals"."number" ~ '^UL-P-[0-9]{4}-[0-9]{6,}$'),
	CONSTRAINT "proposals_recipient_email_check" CHECK ("proposals"."recipient_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "proposals_accepted_check" CHECK (("proposals"."status" = 'accepted') = ("proposals"."accepted_version_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "proposal_access_links" ADD CONSTRAINT "proposal_access_links_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_access_links" ADD CONSTRAINT "proposal_access_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_access_links" ADD CONSTRAINT "proposal_access_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_option_id_proposal_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."proposal_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_options" ADD CONSTRAINT "proposal_options_version_id_proposal_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD CONSTRAINT "proposal_versions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD CONSTRAINT "proposal_versions_terms_template_id_commercial_terms_templates_id_fk" FOREIGN KEY ("terms_template_id") REFERENCES "public"."commercial_terms_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD CONSTRAINT "proposal_versions_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_versions" ADD CONSTRAINT "proposal_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_current_version_id_proposal_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_accepted_version_id_proposal_versions_id_fk" FOREIGN KEY ("accepted_version_id") REFERENCES "public"."proposal_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_access_links_proposal_idx" ON "proposal_access_links" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "proposal_items_option_idx" ON "proposal_items" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "proposal_options_version_idx" ON "proposal_options" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_options_one_recommended" ON "proposal_options" USING btree ("version_id") WHERE "proposal_options"."is_recommended";--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_versions_one_draft" ON "proposal_versions" USING btree ("proposal_id") WHERE "proposal_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_versions_one_sent" ON "proposal_versions" USING btree ("proposal_id") WHERE "proposal_versions"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposals_organization_idx" ON "proposals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "proposals_recipient_email_idx" ON "proposals" USING btree (lower("recipient_email"));--> statement-breakpoint
-- Block 1A — proposals are history: never deleted; current/accepted versions must belong to the proposal.
CREATE OR REPLACE FUNCTION "public"."proposals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: proposals cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."proposal_versions" v WHERE v.id = NEW.current_version_id AND v.proposal_id = NEW.id) THEN
    RAISE EXCEPTION 'current_version_id does not belong to this proposal' USING ERRCODE = '23514';
  END IF;
  IF NEW.accepted_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."proposal_versions" v WHERE v.id = NEW.accepted_version_id AND v.proposal_id = NEW.id) THEN
    RAISE EXCEPTION 'accepted_version_id does not belong to this proposal' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'commercial record is immutable: proposal number/creator cannot change' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposals_guard" BEFORE INSERT OR UPDATE OR DELETE ON "proposals" FOR EACH ROW EXECUTE FUNCTION "public"."proposals_guard"();--> statement-breakpoint
CREATE TRIGGER "proposals_no_truncate" BEFORE TRUNCATE ON "proposals" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Versions: born as draft; sending (sent_at set) requires approved terms and at least one option; once sent the content is
-- frozen: only status (sent -> superseded | withdrawn) and updated_at may change; sent versions are never deleted.
CREATE OR REPLACE FUNCTION "public"."proposal_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'a proposal version must be created as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'commercial record is immutable: a sent proposal version cannot be deleted' USING ERRCODE = 'UL001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
    RAISE EXCEPTION 'commercial record is immutable: proposal_id/version_no cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF OLD.sent_at IS NULL THEN
    IF NEW.sent_at IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM "public"."commercial_terms_templates" t WHERE t.id = NEW.terms_template_id AND t.status = 'approved') THEN
        RAISE EXCEPTION 'a proposal version can only be sent with approved terms' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "public"."proposal_options" o WHERE o.version_id = NEW.id) THEN
        RAISE EXCEPTION 'a proposal version needs at least one option to be sent' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at'])
     OR NOT (NEW.status = OLD.status OR (OLD.status = 'sent' AND NEW.status IN ('superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'commercial record is immutable: a sent proposal version cannot change (only sent -> superseded or withdrawn)' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposal_versions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "proposal_versions" FOR EACH ROW EXECUTE FUNCTION "public"."proposal_versions_guard"();--> statement-breakpoint
CREATE TRIGGER "proposal_versions_no_truncate" BEFORE TRUNCATE ON "proposal_versions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Options/items: editable only while their version is a draft. A missing version means it is being deleted as a draft
-- (sent versions cannot be deleted), so cascades from a draft deletion are allowed.
CREATE OR REPLACE FUNCTION "public"."commercial_version_is_sent"(p_version_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."proposal_versions" v WHERE v.id = p_version_id AND v.sent_at IS NOT NULL)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."proposal_options_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP IN ('UPDATE', 'DELETE') AND "public"."commercial_version_is_sent"(OLD.version_id))
     OR (TG_OP IN ('INSERT', 'UPDATE') AND "public"."commercial_version_is_sent"(NEW.version_id)) THEN
    RAISE EXCEPTION 'commercial record is immutable: options of a sent proposal version cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposal_options_guard" BEFORE INSERT OR UPDATE OR DELETE ON "proposal_options" FOR EACH ROW EXECUTE FUNCTION "public"."proposal_options_guard"();--> statement-breakpoint
CREATE TRIGGER "proposal_options_no_truncate" BEFORE TRUNCATE ON "proposal_options" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."proposal_items_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP IN ('UPDATE', 'DELETE') AND "public"."commercial_version_is_sent"((SELECT o.version_id FROM "public"."proposal_options" o WHERE o.id = OLD.option_id)))
     OR (TG_OP IN ('INSERT', 'UPDATE') AND "public"."commercial_version_is_sent"((SELECT o.version_id FROM "public"."proposal_options" o WHERE o.id = NEW.option_id))) THEN
    RAISE EXCEPTION 'commercial record is immutable: items of a sent proposal version cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."plans" p WHERE p.id = NEW.plan_id AND p.application_id IS NOT DISTINCT FROM NEW.application_id) THEN
    RAISE EXCEPTION 'plan_id does not belong to application_id' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposal_items_guard" BEFORE INSERT OR UPDATE OR DELETE ON "proposal_items" FOR EACH ROW EXECUTE FUNCTION "public"."proposal_items_guard"();--> statement-breakpoint
CREATE TRIGGER "proposal_items_no_truncate" BEFORE TRUNCATE ON "proposal_items" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Access links: never deleted; the identity of the link (token hash, proposal, kind, recipient, creator) is fixed; revocation is final.
CREATE OR REPLACE FUNCTION "public"."proposal_access_links_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: access links cannot be deleted (revoke instead)' USING ERRCODE = 'UL001';
  END IF;
  IF NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)) THEN
    RAISE EXCEPTION 'commercial record is immutable: access link identity/revocation cannot change' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "proposal_access_links_guard" BEFORE UPDATE OR DELETE ON "proposal_access_links" FOR EACH ROW EXECUTE FUNCTION "public"."proposal_access_links_guard"();--> statement-breakpoint
CREATE TRIGGER "proposal_access_links_no_truncate" BEFORE TRUNCATE ON "proposal_access_links" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposal_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposal_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposal_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "proposal_access_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."proposals", "public"."proposal_versions", "public"."proposal_options", "public"."proposal_items", "public"."proposal_access_links" FROM %I', r);
    END IF;
  END LOOP;
END $$;