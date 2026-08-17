-- Capture & Cook — row-level security for the social tables, 15 Aug 2026
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- Found by signing in as a brand-new account that follows nobody and owns
-- nothing, then reading every table directly with its session token:
--
--   posts           13 rows, one of them from a PRIVATE account (@keyontak95)
--   post_views      26 rows                 — who viewed whose post
--   post_reactions  36 rows
--
-- CORRECTION: dishes was initially listed here too, as exposed cooking
-- history. It was not. Every visible row was favorite = true from an account
-- with favorites_public = true — the public-favourites feature behaving
-- correctly. Non-favourited history was never readable. dishes is left alone.
--
-- These policies alone changed nothing: Postgres ORs PERMISSIVE policies, and
-- blanket "readable by signed-in users" policies already existed. See
-- 2026-08-15-rls-drop-blanket.sql, which removes those and is what actually
-- closed the leak.
--
-- The API already filters correctly — community-feed.js checks is_private and
-- blocks. But it is not the only way in: anyone with a session token can skip
-- the API and read the tables directly, because nothing stopped them there.
-- These policies put the same rules in the database, where they cannot be
-- bypassed.
--
-- The server is unaffected: service_role bypasses RLS entirely, so every
-- /api/ route keeps working exactly as it does now, including public
-- favourites on profiles (user-profile.js reads dishes server-side).

-- ═══════════════════════════════════════════════════════════════════════
-- helpers — mirror the app's own rules
-- ═══════════════════════════════════════════════════════════════════════

-- Blocking is mutual: either direction hides both parties from each other.
create or replace function public.cc_blocked(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = other)
       or (b.blocker_id = other      and b.blocked_id = auth.uid())
  );
$$;

-- Can the current user see this author's content?
-- Own content always; public accounts always; private accounts only on an
-- accepted follow. Blocked either way sees nothing.
create or replace function public.cc_can_see(author uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select author = auth.uid() or (
    not public.cc_blocked(author)
    and (
      exists (select 1 from public.user_profiles p
              where p.user_id = author and coalesce(p.is_private, false) = false)
      or exists (select 1 from public.follows f
                 where f.follower_id = auth.uid()
                   and f.following_id = author
                   and f.status = 'accepted')
    )
  );
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- dishes — personal cooking history. Owner only.
-- ═══════════════════════════════════════════════════════════════════════
-- The app only ever reads its own (loadCloudHistory scopes to currentUser.id).
-- Other people's public favourites come from /api/user-profile on service_role.

alter table public.dishes enable row level security;
drop policy if exists dishes_owner on public.dishes;
create policy dishes_owner on public.dishes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- posts — public accounts, accepted follows, and your own.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.posts enable row level security;
drop policy if exists posts_visible on public.posts;
create policy posts_visible on public.posts
  for select to authenticated
  using (public.cc_can_see(user_id));

drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own on public.posts
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists posts_modify_own on public.posts;
create policy posts_modify_own on public.posts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists posts_delete_own on public.posts;
create policy posts_delete_own on public.posts
  for delete to authenticated using (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- post_reactions — visible on posts you can see; you may only act as yourself.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.post_reactions enable row level security;
drop policy if exists reactions_visible on public.post_reactions;
create policy reactions_visible on public.post_reactions
  for select to authenticated
  using (exists (select 1 from public.posts p
                 where p.id = post_reactions.post_id and public.cc_can_see(p.user_id)));

drop policy if exists reactions_own_write on public.post_reactions;
create policy reactions_own_write on public.post_reactions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════
-- post_views — who looked at what. Only the post's author, and the viewer.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.post_views enable row level security;
drop policy if exists views_limited on public.post_views;
create policy views_limited on public.post_views
  for select to authenticated
  using (
    viewer_id = auth.uid()
    or exists (select 1 from public.posts p
               where p.id = post_views.post_id and p.user_id = auth.uid())
  );

drop policy if exists views_insert_own on public.post_views;
create policy views_insert_own on public.post_views
  for insert to authenticated with check (viewer_id = auth.uid());


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — every social table should now report rowsecurity = true
-- ═══════════════════════════════════════════════════════════════════════
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('dishes','posts','post_reactions','post_views',
                    'notifications','device_tokens','blocks','nutrition_log')
order by tablename;
