CREATE SEQUENCE "public"."commercial_contract_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."commercial_proposal_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
-- Block 1A — commercial domain catalog data (idempotent; the role grant is a no-op on a fresh database before seeding).
INSERT INTO "platform_permissions" ("key", "description") VALUES
  ('platform.commercial.read', 'Read proposals, contracts and entitlement grants of every organization.'),
  ('platform.proposal.manage', 'Create/edit proposals and proposal versions (drafts only).'),
  ('platform.proposal.send', 'Send a proposal version (freeze it) and issue/revoke its access links.'),
  ('platform.contract.manage', 'Manage contracts generated from accepted proposals.'),
  ('platform.entitlement.grant', 'Activate/revoke entitlement grants (creates subscriptions/application access).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_role_permissions" ("platform_role_id", "platform_permission_id")
SELECT r."id", p."id" FROM "platform_roles" r, "platform_permissions" p
WHERE r."key" = 'PLATFORM_ADMIN'
  AND p."key" IN ('platform.commercial.read', 'platform.proposal.manage', 'platform.proposal.send', 'platform.contract.manage', 'platform.entitlement.grant')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Organization-scoped read permission for the client side; deliberately NOT assigned to any role here.
INSERT INTO "permissions" ("key", "description") VALUES
  ('commercial.read', 'View the organization''s own proposals and contracts (read-only).')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Defence in depth: the numbering sequences are never usable through the Supabase Data API roles.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE "public"."commercial_proposal_number_seq", "public"."commercial_contract_number_seq" FROM %I', r);
    END IF;
  END LOOP;
END $$;
