CREATE TABLE "contract_renewal_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"authorized_by_user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"period_days" integer NOT NULL,
	"consent_text" text NOT NULL,
	"consent_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_renewal_authorizations_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "contract_renewal_authorizations_amount_check" CHECK ("contract_renewal_authorizations"."amount_minor" >= 0),
	CONSTRAINT "contract_renewal_authorizations_currency_check" CHECK ("contract_renewal_authorizations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "contract_renewal_authorizations_period_check" CHECK ("contract_renewal_authorizations"."period_days" between 1 and 3660),
	CONSTRAINT "contract_renewal_authorizations_consent_sha_check" CHECK ("contract_renewal_authorizations"."consent_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contract_renewal_authorizations_idempotency_check" CHECK (length("contract_renewal_authorizations"."idempotency_key") between 8 and 200),
	CONSTRAINT "contract_renewal_authorizations_withdrawn_check" CHECK (("contract_renewal_authorizations"."withdrawn_at" is null) = ("contract_renewal_authorizations"."withdrawn_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "contract_renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"period_starts_at" timestamp with time zone NOT NULL,
	"period_ends_at" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"lapsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_renewals_sequence_unique" UNIQUE("contract_id","sequence"),
	CONSTRAINT "contract_renewals_period_unique" UNIQUE("contract_id","period_starts_at"),
	CONSTRAINT "contract_renewals_status_check" CHECK ("contract_renewals"."status" in ('awaiting_payment', 'active', 'cancelled', 'lapsed')),
	CONSTRAINT "contract_renewals_sequence_check" CHECK ("contract_renewals"."sequence" > 0),
	CONSTRAINT "contract_renewals_period_check" CHECK ("contract_renewals"."period_ends_at" > "contract_renewals"."period_starts_at"),
	CONSTRAINT "contract_renewals_amount_check" CHECK ("contract_renewals"."amount_minor" >= 0),
	CONSTRAINT "contract_renewals_currency_check" CHECK ("contract_renewals"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "contract_renewals_applied_check" CHECK (("contract_renewals"."status" = 'active') = ("contract_renewals"."applied_at" is not null)),
	CONSTRAINT "contract_renewals_cancelled_check" CHECK (("contract_renewals"."status" = 'cancelled') = ("contract_renewals"."cancelled_at" is not null)),
	CONSTRAINT "contract_renewals_lapsed_check" CHECK (("contract_renewals"."status" = 'lapsed') = ("contract_renewals"."lapsed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "commercial_events" DROP CONSTRAINT "commercial_events_aggregate_type_check";--> statement-breakpoint
DROP INDEX "commercial_payments_one_confirmed_per_contract";--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD COLUMN "renewal_id" uuid;--> statement-breakpoint
ALTER TABLE "contract_renewal_authorizations" ADD CONSTRAINT "contract_renewal_authorizations_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_authorizations" ADD CONSTRAINT "contract_renewal_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_authorizations" ADD CONSTRAINT "contract_renewal_authorizations_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewal_authorizations" ADD CONSTRAINT "contract_renewal_authorizations_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_renewals" ADD CONSTRAINT "contract_renewals_authorization_id_contract_renewal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."contract_renewal_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_renewal_authorizations_one_standing" ON "contract_renewal_authorizations" USING btree ("contract_id") WHERE "contract_renewal_authorizations"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "contract_renewal_authorizations_organization_idx" ON "contract_renewal_authorizations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_renewals_one_awaiting" ON "contract_renewals" USING btree ("contract_id") WHERE "contract_renewals"."status" = 'awaiting_payment';--> statement-breakpoint
CREATE INDEX "contract_renewals_organization_idx" ON "contract_renewals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contract_renewals_status_idx" ON "contract_renewals" USING btree ("status","period_starts_at");--> statement-breakpoint
ALTER TABLE "commercial_payments" ADD CONSTRAINT "commercial_payments_renewal_id_contract_renewals_id_fk" FOREIGN KEY ("renewal_id") REFERENCES "public"."contract_renewals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_payments_one_confirmed_per_renewal" ON "commercial_payments" USING btree ("renewal_id") WHERE "commercial_payments"."status" = 'confirmed' and "commercial_payments"."renewal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_payments_one_confirmed_per_contract" ON "commercial_payments" USING btree ("contract_id") WHERE "commercial_payments"."status" = 'confirmed' and "commercial_payments"."renewal_id" is null;--> statement-breakpoint
ALTER TABLE "commercial_events" ADD CONSTRAINT "commercial_events_aggregate_type_check" CHECK ("commercial_events"."aggregate_type" in ('terms_template', 'proposal', 'proposal_version', 'proposal_access_link', 'proposal_acceptance', 'contract', 'contract_version', 'entitlement_grant', 'payment', 'contract_renewal', 'payment_proof'));--> statement-breakpoint
-- Renewal authorizations are history: inserted, then withdrawn at most once (nothing else ever changes).
CREATE OR REPLACE FUNCTION "public"."contract_renewal_authorizations_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: renewal authorizations cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a renewal authorization must be created standing' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "public"."contracts" c WHERE c.id = NEW.contract_id AND c.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'renewal authorization organization does not match the contract' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['withdrawn_at', 'withdrawn_by_user_id', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['withdrawn_at', 'withdrawn_by_user_id', 'updated_at']) THEN
    RAISE EXCEPTION 'commercial record is immutable: a renewal authorization can only be withdrawn, once' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "contract_renewal_authorizations_guard" BEFORE INSERT OR UPDATE OR DELETE ON "contract_renewal_authorizations" FOR EACH ROW EXECUTE FUNCTION "public"."contract_renewal_authorizations_guard"();--> statement-breakpoint
CREATE TRIGGER "contract_renewal_authorizations_no_truncate" BEFORE TRUNCATE ON "contract_renewal_authorizations" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Renewal periods: identity never changes; awaiting_payment -> active | cancelled | lapsed only; final states are final.
CREATE OR REPLACE FUNCTION "public"."contract_renewals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: renewals cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'awaiting_payment' THEN
      RAISE EXCEPTION 'a renewal must be created awaiting payment' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "public"."contract_renewal_authorizations" a
      WHERE a.id = NEW.authorization_id AND a.contract_id = NEW.contract_id AND a.organization_id = NEW.organization_id AND a.withdrawn_at IS NULL) THEN
      RAISE EXCEPTION 'a renewal needs a standing authorization of the same contract' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'applied_at', 'cancelled_at', 'lapsed_at', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'applied_at', 'cancelled_at', 'lapsed_at', 'updated_at']) THEN
    RAISE EXCEPTION 'commercial record is immutable: renewal identity cannot change' USING ERRCODE = 'UL001';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'awaiting_payment' AND NEW.status IN ('active', 'cancelled', 'lapsed'))) THEN
    RAISE EXCEPTION 'invalid renewal transition % -> %', OLD.status, NEW.status USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status <> 'awaiting_payment' AND (to_jsonb(NEW) - ARRAY['updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'commercial record is immutable: % renewals are final', OLD.status USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "contract_renewals_guard" BEFORE INSERT OR UPDATE OR DELETE ON "contract_renewals" FOR EACH ROW EXECUTE FUNCTION "public"."contract_renewals_guard"();--> statement-breakpoint
CREATE TRIGGER "contract_renewals_no_truncate" BEFORE TRUNCATE ON "contract_renewals" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Payments (0023 guard, extended): a first-period payment must match a contract pending activation; a renewal payment
-- must match its renewal (same contract and organization, awaiting payment, exact amount/currency) of an ACTIVE contract.
CREATE OR REPLACE FUNCTION "public"."commercial_payments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; r record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'commercial record is immutable: % on commercial_payments is not allowed', TG_OP USING ERRCODE = 'UL001';
  END IF;
  SELECT organization_id, currency, total_minor, status INTO c FROM "public"."contracts" WHERE id = NEW.contract_id;
  IF NOT FOUND OR c.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'payment organization does not match the contract' USING ERRCODE = '23514';
  END IF;
  IF NEW.renewal_id IS NULL THEN
    IF c.currency <> NEW.currency OR c.total_minor <> NEW.amount_minor THEN
      RAISE EXCEPTION 'payment amount/currency do not match the contract' USING ERRCODE = '23514';
    END IF;
    IF c.status <> 'pending_activation' THEN
      RAISE EXCEPTION 'only a contract pending activation can receive a payment confirmation' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT contract_id, organization_id, currency, amount_minor, status INTO r FROM "public"."contract_renewals" WHERE id = NEW.renewal_id;
    IF NOT FOUND OR r.contract_id <> NEW.contract_id OR r.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'payment renewal does not belong to the contract' USING ERRCODE = '23514';
    END IF;
    IF r.currency <> NEW.currency OR r.amount_minor <> NEW.amount_minor THEN
      RAISE EXCEPTION 'payment amount/currency do not match the renewal' USING ERRCODE = '23514';
    END IF;
    IF r.status <> 'awaiting_payment' OR c.status <> 'active' THEN
      RAISE EXCEPTION 'only a renewal awaiting payment of an active contract can receive a payment confirmation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Server-side only: closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "contract_renewal_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contract_renewals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contract_renewal_authorizations', 'contract_renewals'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE "public".%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
