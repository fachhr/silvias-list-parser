-- ============================================================================
-- DIAGNOSTIC QUERY: Debug years_of_experience trigger issue
-- ============================================================================
-- Run this in Supabase SQL Editor to understand why years_of_experience is NULL
-- ============================================================================

-- 1. Check the most recent parsing job
SELECT
  id,
  profile_id,
  status,
  completed_at,
  -- Show the raw JSONB
  extracted_data,
  -- Extract years_of_experience in different ways
  extracted_data->'years_of_experience' as years_json,
  extracted_data->>'years_of_experience' as years_text,
  pg_typeof(extracted_data->'years_of_experience') as json_type,
  -- Test the conditions from the CASE statement
  (extracted_data->>'years_of_experience' IS NOT NULL) as is_not_null,
  (extracted_data->>'years_of_experience' ~ '^\d+$') as regex_matches,
  -- Test the cast
  CASE
    WHEN extracted_data->>'years_of_experience' IS NOT NULL
    THEN 'Value exists: "' || extracted_data->>'years_of_experience' || '"'
    ELSE 'Value is NULL'
  END as null_check,
  -- Try the full CASE logic from trigger
  CASE
    WHEN extracted_data->>'years_of_experience' IS NOT NULL AND
         extracted_data->>'years_of_experience' ~ '^\d+$'
    THEN (extracted_data->>'years_of_experience')::INTEGER
    ELSE NULL
  END as computed_years
FROM cv_parsing_jobs
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 1;

-- 2. Check what's in user_profiles for this profile
SELECT
  up.id,
  up.email,
  up.contact_first_name,
  up.years_of_experience,
  up.parsing_completed_at,
  -- Show related parsing job
  cpj.id as job_id,
  cpj.status as job_status,
  cpj.completed_at as job_completed_at,
  cpj.extracted_data->>'years_of_experience' as extracted_years
FROM user_profiles up
LEFT JOIN cv_parsing_jobs cpj ON cpj.profile_id = up.id
WHERE cpj.status = 'completed'
ORDER BY cpj.completed_at DESC
LIMIT 1;

-- 3. Test if the trigger function exists and is correct
SELECT
  p.proname as function_name,
  pg_get_functiondef(p.oid) as function_definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname = 'sync_parsed_cv_data_to_profile'
AND n.nspname = 'public';

-- 4. Test if the trigger exists
SELECT
  trigger_name,
  event_manipulation,
  event_object_table,
  action_timing,
  action_statement
FROM information_schema.triggers
WHERE trigger_name = 'trigger_sync_parsed_cv_data';

-- ============================================================================
-- EXPECTED RESULTS
-- ============================================================================
-- Query 1 should show:
--   - years_text: '17' (or whatever number)
--   - is_not_null: true
--   - regex_matches: true
--   - computed_years: 17 (INTEGER)
--
-- Query 2 should show:
--   - years_of_experience: 17 (matching computed_years from Query 1)
--
-- If computed_years works but years_of_experience is NULL:
--   → The CASE logic is fine, but the UPDATE is not applying
--   → Check trigger function definition (Query 3)
--   → Check trigger exists (Query 4)
--
-- If regex_matches is false:
--   → The value has unexpected format (spaces, newlines, etc.)
--   → Need to adjust regex or trim the value
--
-- If is_not_null is false but extracted_data shows a value:
--   → JSONB structure is different than expected
--   → Maybe years_of_experience is nested deeper
-- ============================================================================
