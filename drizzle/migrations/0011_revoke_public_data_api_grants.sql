-- Fase 5 — defense in depth on the Supabase Data API (PostgREST).
-- Every `public` table already has RLS enabled with NO policies, so anon /
-- authenticated were already denied by RLS. They still held table GRANTs,
-- though — one accidental policy (or RLS disabled on a table) would have
-- re-opened access. No UL client uses the Data API (ul-client, ul-console and
-- na-pista-console use Supabase only for Auth; ul-platform and na-pista use
-- DATABASE_URL as the `postgres` owner role, which is unaffected).
--
-- Revokes current and default (future) privileges for anon/authenticated on
-- `public`. Supabase Auth lives in the `auth` schema and is not touched.
-- Conditional on the Supabase roles existing (local test databases don't have them).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
