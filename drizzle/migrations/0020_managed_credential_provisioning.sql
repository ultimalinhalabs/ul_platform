CREATE TABLE "credential_provisioning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"predecessor_id" uuid,
	"contract_id" uuid,
	"entitlement_grant_id" uuid,
	"current_credential_id" uuid,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_provisioning_status_check" CHECK ("credential_provisioning_requests"."status" in ('REQUESTED', 'ISSUED', 'ACTIVE', 'CANCELLED', 'REVOKED', 'SUPERSEDED')),
	CONSTRAINT "credential_provisioning_kind_check" CHECK ("credential_provisioning_requests"."kind" in ('initial', 'rotation', 'rekey')),
	CONSTRAINT "credential_provisioning_purpose_check" CHECK ("credential_provisioning_requests"."purpose" = 'platform_integration'),
	CONSTRAINT "credential_provisioning_issue_count_check" CHECK ("credential_provisioning_requests"."issue_count" >= 0),
	CONSTRAINT "credential_provisioning_predecessor_check" CHECK (("credential_provisioning_requests"."kind" = 'initial') = ("credential_provisioning_requests"."predecessor_id" is null)),
	CONSTRAINT "credential_provisioning_issued_has_credential_check" CHECK ("credential_provisioning_requests"."status" not in ('ISSUED', 'ACTIVE') or ("credential_provisioning_requests"."current_credential_id" is not null and "credential_provisioning_requests"."issue_count" > 0))
);
--> statement-breakpoint
-- D2-B — credential_class is added nullable, back-filled deterministically from the pre-D2-B model
-- (organization key ⇔ organization_id set; platform key ⇔ organization_id null), then made NOT NULL.
-- From here on the class is the authority; organization_id is never used as a substitute for it.
ALTER TABLE "api_keys" ADD COLUMN "credential_class" text;--> statement-breakpoint
UPDATE "api_keys" SET "credential_class" = CASE WHEN "organization_id" IS NULL THEN 'PLATFORM_SERVICE' ELSE 'ORGANIZATION' END WHERE "credential_class" IS NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "credential_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "provisioning_request_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_entitlement_grant_id_entitlement_grants_id_fk" FOREIGN KEY ("entitlement_grant_id") REFERENCES "public"."entitlement_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_current_credential_id_api_keys_id_fk" FOREIGN KEY ("current_credential_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_provisioning_one_open" ON "credential_provisioning_requests" USING btree ("organization_id","application_id","purpose") WHERE "credential_provisioning_requests"."status" in ('REQUESTED', 'ISSUED');--> statement-breakpoint
CREATE UNIQUE INDEX "credential_provisioning_one_active" ON "credential_provisioning_requests" USING btree ("organization_id","application_id","purpose") WHERE "credential_provisioning_requests"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "credential_provisioning_application_status_idx" ON "credential_provisioning_requests" USING btree ("application_id","status");--> statement-breakpoint
CREATE INDEX "api_keys_provisioning_request_id_idx" ON "api_keys" USING btree ("provisioning_request_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_status_check" CHECK ("api_keys"."status" in ('PENDING', 'ACTIVE', 'REVOKED'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_credential_class_check" CHECK ("api_keys"."credential_class" in ('ORGANIZATION', 'INTEGRATION_MANAGED', 'PLATFORM_SERVICE'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_credential_class_shape_check" CHECK (("api_keys"."credential_class" = 'ORGANIZATION' and "api_keys"."organization_id" is not null and "api_keys"."purpose" is null and "api_keys"."provisioning_request_id" is null)
       or ("api_keys"."credential_class" = 'INTEGRATION_MANAGED' and "api_keys"."organization_id" is not null and "api_keys"."purpose" = 'platform_integration' and "api_keys"."provisioning_request_id" is not null)
       or ("api_keys"."credential_class" = 'PLATFORM_SERVICE' and "api_keys"."organization_id" is null and ("api_keys"."purpose" is null or "api_keys"."purpose" = 'PROVISIONER') and "api_keys"."provisioning_request_id" is null));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_pending_only_managed_check" CHECK ("api_keys"."status" <> 'PENDING' or "api_keys"."credential_class" = 'INTEGRATION_MANAGED');--> statement-breakpoint
-- D2-B — references not expressible in the Drizzle schema without a circular import.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_provisioning_request_id_fk" FOREIGN KEY ("provisioning_request_id") REFERENCES "public"."credential_provisioning_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_provisioning_requests" ADD CONSTRAINT "credential_provisioning_requests_predecessor_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."credential_provisioning_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- D2-B — API key identity is immutable and REVOKED is terminal. Only status (PENDING → ACTIVE → REVOKED,
-- PENDING → REVOKED), revoked_at and updated_at may change.
CREATE OR REPLACE FUNCTION "public"."api_keys_identity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_class IS DISTINCT FROM OLD.credential_class
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.provisioning_request_id IS DISTINCT FROM OLD.provisioning_request_id
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash THEN
    RAISE EXCEPTION 'api key identity is immutable' USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked api key cannot be reactivated' USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'an active api key cannot return to pending' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "api_keys_identity_guard" BEFORE UPDATE ON "api_keys" FOR EACH ROW EXECUTE FUNCTION "public"."api_keys_identity_guard"();--> statement-breakpoint
-- D2-B — provisioning request lifecycle, enforced in the database as well as in the service.
CREATE OR REPLACE FUNCTION "public"."credential_provisioning_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provisioning requests are never deleted' USING ERRCODE = 'UL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NEW.issue_count <> 0 OR NEW.current_credential_id IS NOT NULL THEN
      RAISE EXCEPTION 'a provisioning request must be created as REQUESTED with no credential' USING ERRCODE = '23514';
    END IF;
    IF NEW.predecessor_id IS NOT NULL THEN
      SELECT organization_id, application_id, purpose, status INTO p FROM "public"."credential_provisioning_requests" WHERE id = NEW.predecessor_id;
      IF p IS NULL OR p.organization_id <> NEW.organization_id OR p.application_id <> NEW.application_id OR p.purpose <> NEW.purpose OR p.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'a predecessor must be the ACTIVE request of the same organization, application and purpose' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.predecessor_id IS DISTINCT FROM OLD.predecessor_id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.entitlement_grant_id IS DISTINCT FROM OLD.entitlement_grant_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provisioning request identity is immutable' USING ERRCODE = 'UL001';
  END IF;
  IF NEW.issue_count < OLD.issue_count THEN
    RAISE EXCEPTION 'issue_count is monotonic' USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status IN ('CANCELLED', 'REVOKED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'provisioning request in terminal state % cannot change', OLD.status USING ERRCODE = 'UL001';
  END IF;
  IF NOT (
       NEW.status = OLD.status
    OR (OLD.status = 'REQUESTED' AND NEW.status IN ('ISSUED', 'CANCELLED'))
    OR (OLD.status = 'ISSUED' AND NEW.status IN ('ACTIVE', 'CANCELLED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('REVOKED', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'invalid provisioning transition % -> %', OLD.status, NEW.status USING ERRCODE = 'UL001';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE' AND (NEW.current_credential_id IS DISTINCT FROM OLD.current_credential_id OR NEW.issue_count <> OLD.issue_count) THEN
    RAISE EXCEPTION 'an ACTIVE provisioning request cannot be re-issued' USING ERRCODE = 'UL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "credential_provisioning_guard" BEFORE INSERT OR UPDATE OR DELETE ON "credential_provisioning_requests" FOR EACH ROW EXECUTE FUNCTION "public"."credential_provisioning_guard"();--> statement-breakpoint
CREATE TRIGGER "credential_provisioning_no_truncate" BEFORE TRUNCATE ON "credential_provisioning_requests" FOR EACH STATEMENT EXECUTE FUNCTION "public"."commercial_forbid_mutation"();--> statement-breakpoint
-- Closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "credential_provisioning_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."credential_provisioning_requests" FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- D2-B — the provisioner scope (catalog data, idempotent). Allow-listed for NA_PISTA only; the service
-- additionally restricts it to PLATFORM_SERVICE credentials with purpose PROVISIONER.
INSERT INTO "service_scopes" ("key", "description") VALUES
  ('credential.provision', 'Issue integration credentials for open provisioning requests of the credential''s own application (provisioner only).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "application_service_scopes" ("application_id", "service_scope_id")
SELECT a."id", s."id" FROM "applications" a, "service_scopes" s
WHERE a."key" = 'NA_PISTA' AND s."key" = 'credential.provision'
ON CONFLICT DO NOTHING;
