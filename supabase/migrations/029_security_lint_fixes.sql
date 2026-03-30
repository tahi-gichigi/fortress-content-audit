-- Security lint fixes
-- Resolves: RLS disabled on blog_posts + guideline_versions, mutable search_path
-- on 5 functions, overly permissive email_captures policy.
-- brand_audit_runs USING(true) is intentionally kept — see migration 012.

-- ============================================================
-- 1. blog_posts — enable RLS, no policies (table not in use;
--    locks it down so only service_role can access it)
-- ============================================================
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. guideline_versions — enable RLS + owner-scoped policy
--    via parent guideline (no user_id column on this table)
-- ============================================================
ALTER TABLE public.guideline_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guideline versions accessible by guideline owner"
  ON public.guideline_versions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.guidelines g
      WHERE g.id = guideline_id
        AND g.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.guidelines g
      WHERE g.id = guideline_id
        AND g.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. email_captures — replace USING(true)/WITH CHECK(true)
--    with targeted policies:
--    - anon can INSERT (capture flow uses anon key)
--    - no SELECT/UPDATE/DELETE for anon (service_role bypasses)
-- ============================================================
DROP POLICY IF EXISTS "Allow all operations on email_captures" ON public.email_captures;

-- Anon INSERT: needed by /api/capture-email POST route (anon key)
CREATE POLICY "email_captures_anon_insert"
  ON public.email_captures
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- ============================================================
-- 4. Fix mutable search_path on all 5 functions
--    Prevents search_path hijacking by pinning to public schema
-- ============================================================

-- 4a. update_updated_at_column (blog_posts trigger)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 4b. set_updated_at (profiles trigger)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 4c. update_scheduled_audits_updated_at
CREATE OR REPLACE FUNCTION public.update_scheduled_audits_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 4d. update_brand_onboarding_updated_at
CREATE OR REPLACE FUNCTION public.update_brand_onboarding_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 4e. check_claim_allowed — source not in codebase (likely a Supabase
--     template remnant). Use ALTER FUNCTION to pin search_path in place.
ALTER FUNCTION public.check_claim_allowed() SET search_path = '';
