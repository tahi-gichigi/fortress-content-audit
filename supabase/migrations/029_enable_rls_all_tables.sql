-- Enable RLS on public tables that are missing it
-- Fixes Supabase security advisor critical warning (flagged 23 Mar 2026)
-- 
-- Two tables were created without RLS:
--   blog_posts (001_create_blog_posts.sql)
--   guideline_versions (003_create_core_tables.sql)
--
-- All other tables already have RLS enabled.
-- brand_audit_runs has RLS enabled with a permissive policy (USING true)
-- as documented in 012_simple_rls_policy.sql — left as-is since server-side
-- auth enforces access control and service_role bypasses RLS.

BEGIN;

-- 1. blog_posts — public content, enable RLS with public read policy
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read published blog posts (they're public content)
CREATE POLICY "Published blog posts are public"
  ON public.blog_posts
  FOR SELECT
  USING (is_published = true);

-- Write operations use service_role (bypasses RLS) — no write policy needed


-- 2. guideline_versions — user content, enable RLS with owner policy
ALTER TABLE public.guideline_versions ENABLE ROW LEVEL SECURITY;

-- Users can access versions of their own guidelines (via parent table)
CREATE POLICY "Guideline versions viewable by guideline owner"
  ON public.guideline_versions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.guidelines g
      WHERE g.id = guideline_id
      AND g.user_id = auth.uid()
    )
  );

COMMIT;
