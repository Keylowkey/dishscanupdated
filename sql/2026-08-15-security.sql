-- Capture & Cook — security hardening, 15 Aug 2026
-- Run this whole file in the Supabase SQL editor. Safe to run more than once.
--
-- NOTE: the first version of this file used column-level REVOKE while the
-- table-level SELECT grant was still in place. In PostgreSQL a table-level
-- privilege covers every column, so those REVOKEs did nothing. The only way to
-- hide a column is to drop the table-level grant and grant back the columns
-- that should stay visible. That is what this does.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. STOP LEAKING EVERY USER'S EMAIL ADDRESS
-- ═══════════════════════════════════════════════════════════════════════
-- user_profiles is readable with the anon key, which ships inside the app
-- bundle and can be pulled out of it in seconds. That is intended for the
-- social columns — but the table also carries `email`, so every registered
-- address was downloadable, including from accounts using Hide My Email.
--
-- The server is unaffected: it uses service_role, which ignores these grants.

REVOKE SELECT, INSERT, UPDATE ON public.user_profiles FROM anon, authenticated;

-- Signed-out callers need exactly one thing: the username-availability check
-- during sign-up. Nothing more.
GRANT SELECT (id, username) ON public.user_profiles TO anon;

-- Signed-in callers get the social columns. `email`, `scan_count` and the
-- subscription columns are deliberately absent.
GRANT SELECT (
  id, user_id, username, full_name, avatar_photo, avatar_color, avatar_icon,
  is_private, favorites_public, nutrition_share, nutrition_visibility, created_at
) ON public.user_profiles TO authenticated;

-- Writes: the app upserts its own row at sign-up and when setting a username.
-- `email` is writable but not readable — separate privileges, so this is fine.
-- scan_count / subscription_status / subscription_end_date are NOT writable:
-- they were table-level UPDATE-able, which let any user hand themselves a
-- subscription with a single request.
GRANT INSERT (id, user_id, username, email, full_name) ON public.user_profiles TO anon;
GRANT INSERT, UPDATE (
  id, user_id, username, email, full_name, avatar_photo, avatar_color,
  avatar_icon, is_private, favorites_public, nutrition_share, nutrition_visibility
) ON public.user_profiles TO authenticated;

-- Users can still read their own full row, email included, through this view.
create or replace view public.my_profile
with (security_invoker = off) as
  select * from public.user_profiles where user_id = auth.uid();

grant select on public.my_profile to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. RATE-LIMIT COUNTERS FOR THE PAID ENDPOINTS
-- ═══════════════════════════════════════════════════════════════════════
-- Backs lib/guard.js. The guard fails open while this table is missing, so
-- creating it is what actually switches throttling on.

create table if not exists public.rate_limits (
  id         bigserial primary key,
  subject    text        not null,          -- 'u:<user-id>' or 'ip:<address>'
  bucket     text        not null,          -- which endpoint
  created_at timestamptz not null default now()
);

create index if not exists rate_limits_lookup
  on public.rate_limits (subject, bucket, created_at desc);

-- Only the server (service_role) touches this. RLS on with no policy means
-- anon and authenticated get nothing, which is exactly right.
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create or replace function public.prune_rate_limits() returns void
language sql security definer set search_path = public as $$
  delete from public.rate_limits where created_at < now() - interval '1 day';
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. VERIFY  — expect ZERO rows
-- ═══════════════════════════════════════════════════════════════════════
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_name = 'user_profiles'
  and column_name in ('email','scan_count','subscription_status','subscription_end_date')
  and grantee in ('anon','authenticated')
  and privilege_type = 'SELECT';
