CREATE TABLE "payment_proof_files" (
	"proof_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"renewal_id" uuid,
	"method" text NOT NULL,
	"declared_reference" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proofs_status_check" CHECK ("payment_proofs"."status" in ('submitted', 'accepted', 'rejected')),
	CONSTRAINT "payment_proofs_method_check" CHECK ("payment_proofs"."method" in ('bank_transfer', 'multicaixa_express')),
	CONSTRAINT "payment_proofs_reference_check" CHECK (length("payment_proofs"."declared_reference") between 1 and 200),
	CONSTRAINT "payment_proofs_file_name_check" CHECK (length("payment_proofs"."file_name") between 1 and 200),
	CONSTRAINT "payment_proofs_content_type_check" CHECK ("payment_proofs"."content_type" = 'application/pdf'),
	CONSTRAINT "payment_proofs_size_check" CHECK ("payment_proofs"."size_bytes" between 1 and 4194304),
	CONSTRAINT "payment_proofs_sha_check" CHECK ("payment_proofs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_proofs_review_check" CHECK (("payment_proofs"."status" = 'submitted') = ("payment_proofs"."reviewed_at" is null)),
	CONSTRAINT "payment_proofs_rejection_check" CHECK (("payment_proofs"."status" = 'rejected') = ("payment_proofs"."rejection_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "payment_proof_files" ADD CONSTRAINT "payment_proof_files_proof_id_payment_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."payment_proofs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_renewal_id_contract_renewals_id_fk" FOREIGN KEY ("renewal_id") REFERENCES "public"."contract_renewals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_proofs_same_file_unique" ON "payment_proofs" USING btree ("contract_id",coalesce("renewal_id", '00000000-0000-0000-0000-000000000000'::uuid),"sha256");--> statement-breakpoint
CREATE INDEX "payment_proofs_contract_idx" ON "payment_proofs" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "payment_proofs_status_idx" ON "payment_proofs" USING btree ("status","created_at");--> statement-breakpoint
-- Proofs: identity and file never change; submitted -> accepted | rejected only, once. The file bytes are never updated.
CREATE OR REPLACE FUNCTION "public"."payment_proofs_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial record is immutable: payment proofs cannot be deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' THEN
      RAISE EXCEPTION 'a payment proof must be created submitted' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "public"."contracts" c WHERE c.id = NEW.contract_id AND c.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'payment proof organization does not match the contract' USING ERRCODE = '23514';
    END IF;
    IF NEW.renewal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "public"."contract_renewals" r WHERE r.id = NEW.renewal_id AND r.contract_id = NEW.contract_id) THEN
      RAISE EXCEPTION 'payment proof renewal does not belong to the contract' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'submitted' OR NEW.status NOT IN ('accepted', 'rejected')
     OR (to_jsonb(NEW) - ARRAY['status', 'reviewed_by_user_id', 'reviewed_at', 'rejection_reason', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'reviewed_by_user_id', 'reviewed_at', 'rejection_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'commercial record is immutable: a payment proof can only be reviewed once' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "payment_proofs_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payment_proofs" FOR EACH ROW EXECUTE FUNCTION "public"."payment_proofs_guard"();--> statement-breakpoint
CREATE TRIGGER "payment_proofs_no_truncate" BEFORE TRUNCATE ON "payment_proofs" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "payment_proof_files_no_update" BEFORE UPDATE OR DELETE ON "payment_proof_files" FOR EACH ROW EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
CREATE TRIGGER "payment_proof_files_no_truncate" BEFORE TRUNCATE ON "payment_proof_files" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Server-side only: closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "payment_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_proof_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_proofs', 'payment_proof_files'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE "public".%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
-- Catalog data (idempotent; mirrors db/seed/data.ts). Reading a client's proof is its own permission.
INSERT INTO "platform_permissions" ("key", "description") VALUES
  ('platform.payment_proof.read', 'Open the payment proofs (PDF) clients uploaded for their contracts.')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Prepared for the future (owner decision 2026-10-16): a finance tier that only reads contracts, opens proofs and
-- confirms payments. Nobody holds it yet; PLATFORM_ADMIN keeps every permission.
INSERT INTO "platform_roles" ("key", "name", "description") VALUES
  ('PLATFORM_FINANCE', 'Platform Finance', 'Reads contracts, opens payment proofs and confirms payments (no other platform authority).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE (r."key" = 'PLATFORM_ADMIN' AND p."key" = 'platform.payment_proof.read')
   OR (r."key" = 'PLATFORM_FINANCE' AND p."key" IN ('platform.commercial.read', 'platform.payment.confirm', 'platform.payment_proof.read'))
ON CONFLICT DO NOTHING;
