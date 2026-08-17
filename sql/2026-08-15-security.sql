-- Capture & Cook — security hardening, 15 Aug 2026
-- Run this whole file in the Supabase SQL editor. It is safe to run twice.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. STOP LEAKING EVERY USER'S EMAIL ADDRESS
-- ═══════════════════════════════════════════════════════════════════════
-- user_profiles is readable with the anon key, which ships inside the app
-- bundle and can be pulled out of it in seconds. That is intended for the
-- social columns (username, display name, avatar) — it is how profiles and
-- the username-availability check work while signed out.
--
-- But the table also carries `email`, so anyone could download the address of
-- every registered user. Column-level privileges fix this without touching the
-- social features: PostgREST refuses any request that selects a revoked column.
--
-- The server keeps working: it uses the service_role key, which these REVOKEs
-- do not apply to (send-username and report-post still read email fine).
-- The app never reads email from this table — it reads it from the session.

REVOKE SELECT (email)                 ON public.user_profiles FROM anon, authenticated;
REVOKE SELECT (scan_count)            ON public.user_profiles FROM anon, authenticated;
REVOKE SELECT (subscription_status)   ON public.user_profiles FROM anon, authenticated;
REVOKE SELECT (subscription_end_date) ON public.user_profiles FROM anon, authenticated;

-- Let users still read (and edit) their OWN email through a narrow view.
create or replace view public.my_profile
with (security_invoker = on) as
  select * from public.user_profiles where user_id = auth.uid();

grant select on public.my_profile to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. RATE-LIMIT COUNTERS FOR THE PAID ENDPOINTS
-- ═══════════════════════════════════════════════════════════════════════
-- Backs lib/guard.js. Without this table the guard fails open (allows the
-- call), so creating it is what actually switches throttling on.

create table if not exists public.rate_limits (
  id         bigserial primary key,
  subject    text        not null,          -- 'u:<user-id>' or 'ip:<address>'
  bucket     text        not null,          -- which endpoint
  created_at timestamptz not null default now()
);

create index if not exists rate_limits_lookup
  on public.rate_limits (subject, bucket, created_at desc);

-- Only the server (service_role) touches this. Enabling RLS with no policy
-- means anon and authenticated get nothing, which is exactly right.
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- Keep the table small — nothing older than a day is of any use.
create or replace function public.prune_rate_limits() returns void
language sql security definer set search_path = public as $$
  delete from public.rate_limits where created_at < now() - interval '1 day';
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. VERIFY
-- ═══════════════════════════════════════════════════════════════════════
-- Should return zero rows for email — proof the column is no longer readable
-- by the roles the app ships credentials for.
select grantee, privilege_type
from information_schema.column_privileges
where table_name = 'user_profiles'
  and column_name = 'email'
  and grantee in ('anon', 'authenticated');
