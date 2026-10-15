CREATE TABLE "commercial_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"external_reference" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_by_api_key_id" uuid,
	"evidence_reference" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_payments_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "commercial_payments_reference_unique" UNIQUE("source","external_reference"),
	CONSTRAINT "commercial_payments_status_check" CHECK ("commercial_payments"."status" in ('confirmed')),
	CONSTRAINT "commercial_payments_source_check" CHECK ("commercial_payments"."source" in ('manual', 'integration')),
	CONSTRAINT "commercial_payments_method_check" CHECK ("commercial_payments"."method" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "commercial_payments_amount_check" CHECK ("commercial_payments"."amount_minor" >= 0),
	CONSTRAINT "commercial_payments_currency_check" CHECK ("commercial_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "commercial_payments_reference_check" CHECK (length("commercial_payments"."external_reference") between 1 and 200),
	CONSTRAINT "commercial_payments_evidence_check" CHECK ("commercial_payments"."evidence_reference" is null or length("commercial_payments"."evidence_reference") between 1 and 500),
	CONSTRAINT "commercial_payments_idempotency_check" CHECK (length("commercial_payments"."idempotency_key") between 8 and 200),
	CONSTRAINT "commercial_payments_confirmer_check" CHECK (("commercial_payments"."source" = 'manual' and "commercial_payments"."confirmed_by_user_id" is not null and "commercial_payments"."confirmed_by_api_key_id" is null)
        or ("commercial_payments"."source" = 'integration' and "commercial_payments"."confirmed_by_api_key_id" is not null and "commercial_payments"."confirmed_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "commercial_events" DROP CONSTRAINT "commercial_events_aggregate_type_check";--> statement-breakpoint
ALTER TABLE "entitlement_grants" DROP CONSTRAINT "entitlement_grants_activation_check";--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "activated_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD CONSTRAINT "commercial_payments_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD CONSTRAINT "commercial_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD CONSTRAINT "commercial_payments_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD CONSTRAINT "commercial_payments_confirmed_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("confirmed_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_payments_one_confirmed_per_contract" ON "commercial_payments" USING btree ("contract_id") WHERE "commercial_payments"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "commercial_payments_organization_idx" ON "commercial_payments" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_activated_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("activated_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_events" ADD CONSTRAINT "commercial_events_aggregate_type_check" CHECK ("commercial_events"."aggregate_type" in ('terms_template', 'proposal', 'proposal_version', 'proposal_access_link', 'proposal_acceptance', 'contract', 'contract_version', 'entitlement_grant', 'payment'));--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_activation_check" CHECK ("entitlement_grants"."status" = 'planned' or ("entitlement_grants"."activated_at" is not null and ("entitlement_grants"."activated_by" is not null or "entitlement_grants"."activated_by_api_key_id" is not null)) or "entitlement_grants"."status" = 'revoked');--> statement-breakpoint
-- Payment confirmations are history: append-only, and an insert must match its contract exactly (defense in depth for the service checks).
CREATE OR REPLACE FUNCTION "public"."commercial_payments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'commercial record is immutable: % on commercial_payments is not allowed', TG_OP USING ERRCODE = 'UL001';
  END IF;
  SELECT organization_id, currency, total_minor, status INTO c FROM "public"."contracts" WHERE id = NEW.contract_id;
  IF NOT FOUND OR c.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'payment organization does not match the contract' USING ERRCODE = '23514';
  END IF;
  IF c.currency <> NEW.currency OR c.total_minor <> NEW.amount_minor THEN
    RAISE EXCEPTION 'payment amount/currency do not match the contract' USING ERRCODE = '23514';
  END IF;
  IF c.status <> 'pending_activation' THEN
    RAISE EXCEPTION 'only a contract pending activation can receive a payment confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "commercial_payments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "commercial_payments" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_payments_guard"();--> statement-breakpoint
CREATE TRIGGER "commercial_payments_no_truncate" BEFORE TRUNCATE ON "commercial_payments" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Server-side only: closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "commercial_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."commercial_payments" FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Manual confirmation permission (catalog data, idempotent; mirrors db/seed/data.ts), granted to PLATFORM_ADMIN only.
INSERT INTO "platform_permissions" ("key", "description") VALUES
  ('platform.payment.confirm', 'Record a manual payment confirmation for a contract (with evidence; audited).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.payment.confirm'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Integration confirmation scope, allow-listed for the payments application only.
INSERT INTO "service_scopes" ("key", "description") VALUES
  ('payment.confirm', 'Confirm that the amount of a UL contract was received (platform service credential of the payments application).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "application_service_scopes" ("application_id", "service_scope_id")
SELECT a."id", s."id" FROM "applications" a, "service_scopes" s
WHERE a."key" = 'MICHA_EXPRESS' AND s."key" = 'payment.confirm'
ON CONFLICT DO NOTHING;
