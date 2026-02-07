-- RLS Policy Migration: Tighten user_profiles INSERT and lock down talent_profiles
--
-- user_profiles: Replace the overly permissive public INSERT policy with one
--   that only lets authenticated users insert their own row (id = auth.uid()).
--
-- talent_profiles: Enable RLS and restrict access to the service role,
--   since only the parser service (using service_role key) writes to this table.
--
-- Run this in the Supabase SQL Editor. The parser service uses SUPABASE_SERVICE_ROLE_KEY
-- which bypasses RLS, so no application code changes are needed.
--
-- IMPORTANT: Before running, verify the exact existing policy name:
--   SELECT policyname FROM pg_policies WHERE tablename = 'user_profiles';

BEGIN;

-- Fix user_profiles INSERT policy
DROP POLICY IF EXISTS "Allow public insert on user_profiles" ON user_profiles;

CREATE POLICY "Allow users to insert own profile" ON user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- Lock down talent_profiles
ALTER TABLE talent_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access on talent_profiles" ON talent_profiles
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMIT;
