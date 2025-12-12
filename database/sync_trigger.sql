-- ============================================================================
-- Silvia's List - Automatic Data Sync Trigger
-- ============================================================================
-- Purpose: Automatically sync parsed CV data from cv_parsing_jobs to user_profiles
-- When: After parser completes CV extraction
-- How: Database trigger fires on cv_parsing_jobs status change to 'completed'
--
-- Author: Claude Code (Anthropic)
-- Date: 2025-01-15
-- ============================================================================

-- ============================================================================
-- FUNCTION: sync_parsed_cv_data_to_profile()
-- ============================================================================
-- Description:
--   Transfers extracted CV data from cv_parsing_jobs.extracted_data (JSONB)
--   to the corresponding user_profiles record.
--
-- Trigger Condition:
--   Fires when cv_parsing_jobs.status changes to 'completed'
--
-- Data Transfer:
--   - Education history
--   - Professional experience
--   - Languages and proficiencies
--   - Technical, soft, and industry-specific skills
--   - Certifications
--   - Professional interests
--   - Extracurricular activities
--   - Projects
--   - Enhanced contact information (address, GitHub, portfolio)
--   - Profile picture storage path
--   - Parsing completion timestamp
--
-- Error Handling:
--   - Uses COALESCE to preserve existing data if extraction fails
--   - JSONB casting with safe fallbacks
--   - Atomic transaction (all or nothing)
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_parsed_cv_data_to_profile()
RETURNS TRIGGER AS $$
DECLARE
  v_profile_id UUID;
  v_rows_updated INTEGER;
  v_written_years INTEGER;
BEGIN
  -- Log trigger activation
  RAISE NOTICE 'Trigger activated: sync_parsed_cv_data_to_profile for job ID %', NEW.id;

  -- Only proceed if parsing completed successfully with extracted data
  IF NEW.status = 'completed' AND NEW.extracted_data IS NOT NULL THEN

    -- Validate profile_id exists
    IF NEW.profile_id IS NULL THEN
      RAISE WARNING 'cv_parsing_jobs.profile_id is NULL for job %. Skipping sync.', NEW.id;
      RETURN NEW;
    END IF;

    -- Log data sync start
    RAISE NOTICE 'Syncing parsed data for profile % from job %', NEW.profile_id, NEW.id;

    -- DEBUG: Log years_of_experience value and type
    RAISE NOTICE '[DEBUG] extracted_data type: %', pg_typeof(NEW.extracted_data);
    RAISE NOTICE '[DEBUG] years_of_experience raw: %', NEW.extracted_data->'years_of_experience';
    RAISE NOTICE '[DEBUG] years_of_experience as text: %', NEW.extracted_data->>'years_of_experience';
    RAISE NOTICE '[DEBUG] IS NOT NULL check: %', (NEW.extracted_data->>'years_of_experience' IS NOT NULL);
    RAISE NOTICE '[DEBUG] regex match: %', (NEW.extracted_data->>'years_of_experience' ~ '^\d+$');

    -- Perform atomic update to user_profiles
    UPDATE user_profiles
    SET
      -- ================================================================
      -- EDUCATION HISTORY
      -- ================================================================
      -- Array of education entries (universities, degrees, fields, grades, dates)
      education_history = COALESCE(
        (NEW.extracted_data->>'education_history')::JSONB,
        education_history
      ),

      -- ================================================================
      -- PROFESSIONAL EXPERIENCE
      -- ================================================================
      -- Array of work experience entries (companies, positions, dates, responsibilities)
      professional_experience = COALESCE(
        (NEW.extracted_data->>'professional_experience')::JSONB,
        professional_experience
      ),

      -- ================================================================
      -- LANGUAGES
      -- ================================================================
      -- Array of languages with proficiency levels (A1-C2)
      base_languages = COALESCE(
        (NEW.extracted_data->>'base_languages')::JSONB,
        base_languages
      ),

      -- ================================================================
      -- SKILLS
      -- ================================================================
      -- Technical skills (programming, software, tools)
      technical_skills = COALESCE(
        (NEW.extracted_data->>'technical_skills')::JSONB,
        technical_skills
      ),

      -- Soft skills (communication, leadership, teamwork)
      soft_skills = COALESCE(
        (NEW.extracted_data->>'soft_skills')::JSONB,
        soft_skills
      ),

      -- Industry-specific skills (domain expertise)
      industry_specific_skills = COALESCE(
        (NEW.extracted_data->>'industry_specific_skills')::JSONB,
        industry_specific_skills
      ),

      -- ================================================================
      -- CERTIFICATIONS & PROFESSIONAL DEVELOPMENT
      -- ================================================================
      -- Professional certifications and licenses
      certifications = COALESCE(
        (NEW.extracted_data->>'certifications')::JSONB,
        certifications
      ),

      -- Professional interests and areas of expertise
      professional_interests = COALESCE(
        (NEW.extracted_data->>'professional_interests')::JSONB,
        professional_interests
      ),

      -- ================================================================
      -- ACTIVITIES & PROJECTS
      -- ================================================================
      -- Extracurricular activities, volunteering, hobbies
      extracurricular_activities = COALESCE(
        (NEW.extracted_data->>'extracurricular_activities')::JSONB,
        extracurricular_activities
      ),

      -- Personal and professional projects
      base_projects = COALESCE(
        (NEW.extracted_data->>'base_projects')::JSONB,
        base_projects
      ),

      -- ================================================================
      -- ENHANCED CONTACT INFORMATION
      -- ================================================================
      -- Physical address (extracted from CV if present)
      contact_address = COALESCE(
        (NEW.extracted_data->>'contact_address')::JSONB,
        contact_address
      ),

      -- GitHub profile URL
      githubUrl = COALESCE(
        NEW.extracted_data->>'githubUrl',
        githubUrl
      ),

      -- Portfolio/personal website URL
      portfolioUrl = COALESCE(
        NEW.extracted_data->>'portfolioUrl',
        portfolioUrl
      ),

      -- ================================================================
      -- YEARS OF EXPERIENCE
      -- ================================================================
      -- Calculated experience level from professional work history
      years_of_experience = CASE
        WHEN NEW.extracted_data->>'years_of_experience' IS NOT NULL AND
             NEW.extracted_data->>'years_of_experience' ~ '^\d+$'
        THEN (NEW.extracted_data->>'years_of_experience')::INTEGER
        ELSE years_of_experience
      END,

      -- ================================================================
      -- PROFILE PICTURE
      -- ================================================================
      -- Storage path for extracted profile picture (if found in CV)
      profile_picture_storage_path = COALESCE(
        NEW.extracted_data->>'profile_picture_storage_path',
        profile_picture_storage_path
      ),

      -- ================================================================
      -- PROFILE BIO (AI-GENERATED)
      -- ================================================================
      -- Professional summary generated by GPT after CV parsing
      profile_bio = COALESCE(
        NEW.extracted_data->>'profile_bio',
        profile_bio
      ),

      -- ================================================================
      -- SYSTEM TIMESTAMP
      -- ================================================================
      -- Record when parsing completed successfully
      parsing_completed_at = NEW.completed_at

    WHERE id = NEW.profile_id;

    -- Get number of rows updated
    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

    -- DEBUG: Check what was actually written
    SELECT years_of_experience INTO v_written_years
    FROM user_profiles
    WHERE id = NEW.profile_id;

    RAISE NOTICE '[DEBUG] years_of_experience written to DB: %', v_written_years;

    -- Log result
    IF v_rows_updated = 1 THEN
      RAISE NOTICE 'Successfully synced parsed data to user_profiles for profile %', NEW.profile_id;
    ELSIF v_rows_updated = 0 THEN
      RAISE WARNING 'No user_profiles record found with id %. Data not synced.', NEW.profile_id;
    ELSE
      RAISE WARNING 'Unexpected: % rows updated for profile %. Expected 1.', v_rows_updated, NEW.profile_id;
    END IF;

  ELSE
    -- Log skipped sync
    IF NEW.status != 'completed' THEN
      RAISE NOTICE 'Skipping sync: Job % status is "%" (not "completed")', NEW.id, NEW.status;
    ELSIF NEW.extracted_data IS NULL THEN
      RAISE WARNING 'Skipping sync: Job % has NULL extracted_data', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: trigger_sync_parsed_cv_data
-- ============================================================================
-- Description:
--   Fires after cv_parsing_jobs table is updated
--   Only executes when status changes from non-completed to completed
--
-- Timing: AFTER UPDATE (ensures cv_parsing_jobs row is committed first)
-- Granularity: FOR EACH ROW (individual job processing)
-- Condition: NEW.status = 'completed' AND OLD.status != 'completed'
-- ============================================================================

-- Drop existing trigger if it exists (safe migration)
DROP TRIGGER IF EXISTS trigger_sync_parsed_cv_data ON cv_parsing_jobs;

-- Create trigger
CREATE TRIGGER trigger_sync_parsed_cv_data
  AFTER UPDATE ON cv_parsing_jobs
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status != 'completed')
  EXECUTE FUNCTION sync_parsed_cv_data_to_profile();

-- ============================================================================
-- DOCUMENTATION
-- ============================================================================

COMMENT ON FUNCTION sync_parsed_cv_data_to_profile() IS
  'Automatically transfers parsed CV data from cv_parsing_jobs.extracted_data (JSONB) to user_profiles when parsing completes. Preserves existing data using COALESCE fallbacks. Logs sync activity via RAISE NOTICE/WARNING.';

COMMENT ON TRIGGER trigger_sync_parsed_cv_data ON cv_parsing_jobs IS
  'Fires when cv_parsing_jobs.status changes to "completed". Calls sync_parsed_cv_data_to_profile() to update user_profiles with extracted CV data.';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- Use these queries to verify the trigger is working correctly

-- 1. Check trigger exists
-- SELECT trigger_name, event_manipulation, event_object_table, action_timing
-- FROM information_schema.triggers
-- WHERE trigger_name = 'trigger_sync_parsed_cv_data';

-- 2. Check function exists
-- SELECT routine_name, routine_type, routine_definition
-- FROM information_schema.routines
-- WHERE routine_name = 'sync_parsed_cv_data_to_profile';

-- 3. Test data sync after parsing
-- SELECT
--   up.id,
--   up.email,
--   up.contact_first_name,
--   up.parsing_completed_at,
--   jsonb_array_length(up.education_history) AS education_count,
--   jsonb_array_length(up.professional_experience) AS experience_count,
--   jsonb_array_length(up.technical_skills) AS skills_count,
--   cpj.status AS parsing_status,
--   cpj.completed_at AS parsing_completed
-- FROM user_profiles up
-- LEFT JOIN cv_parsing_jobs cpj ON cpj.profile_id = up.id
-- WHERE up.email = 'test@example.com';

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
