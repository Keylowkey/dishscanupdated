-- Capture & Cook — remove the blanket-allow policies, 15 Aug 2026
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- The restrictive policies added earlier were inert. Postgres combines
-- PERMISSIVE policies with OR, so a blanket policy alongside them means any
-- row matching EITHER is visible. These three are the blanket ones:
--
--   posts          "Posts readable by signed-in users"      using (auth.uid() IS NOT NULL)
--   post_reactions "Reactions readable by signed-in users"  using (auth.uid() IS NOT NULL)
--   post_views     "cc_post_views_read"                     using (true)
--
-- Dropping them leaves posts_visible / reactions_visible / views_limited as
-- the only SELECT paths, which is what was intended all along.
--
-- dishes is deliberately NOT touched: it has no blanket policy. Its rows were
-- visible through cc_dishes_public_favorites, which is the public-favourites
-- feature working as designed, not a leak.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Harden the visibility helper first
-- ═══════════════════════════════════════════════════════════════════════
-- user_profiles carries both `id` and `user_id`, and the existing policies
-- disagree about which identifies the owner (cc_dishes_public_favorites uses
-- p.id, the app writes both). Accept either, so a mismatch can never silently
-- hide every post.

create or replace function public.cc_can_see(author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select author = auth.uid() or (
    not public.cc_blocked(author)
    and (
      exists (select 1 from public.user_profiles p
              where (p.user_id = author or p.id = author)
                and coalesce(p.is_private, false) = false)
      or exists (select 1 from public.follows f
                 where f.follower_id = auth.uid()
                   and f.following_id = author
                   and f.status = 'accepted')
    )
  );
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Drop the three blanket SELECT policies
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists "Posts readable by signed-in users"     on public.posts;
drop policy if exists "Reactions readable by signed-in users" on public.post_reactions;
drop policy if exists "cc_post_views_read"                    on public.post_views;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. VERIFY — expect exactly one SELECT policy per table, the scoped one
-- ═══════════════════════════════════════════════════════════════════════
select tablename, policyname, roles::text, qual as using_expr
from pg_policies
where schemaname = 'public'
  and cmd = 'SELECT'
  and tablename in ('posts','post_reactions','post_views')
order by tablename, policyname;
