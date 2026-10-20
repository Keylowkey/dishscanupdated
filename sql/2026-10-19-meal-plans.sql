-- Capture & Cook — "Choose for Me" meal plans, 19 Oct 2026
-- Run in the Supabase SQL editor. Safe to run more than once.

-- ═══════════════════════════════════════════════════════════════════════
-- meal_plans — a user's saved plans. Owner only.
-- ═══════════════════════════════════════════════════════════════════════
-- The app reads and writes its own rows directly, like dishes.
--   prefs    the questionnaire answers the plan was made from
--   plan     { startDate, days: [{ date, meals: [...] }] }
--   grocery  the user's own list state: checked, have-at-home, custom items
--   summary  { days, meals, cost, household, start } so the list of plans
--            loads without fetching every full plan
create table if not exists public.meal_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text not null default 'Meal plan',
  period      text not null check (period in ('daily', 'weekly', 'monthly')),
  prefs       jsonb not null default '{}'::jsonb,
  plan        jsonb not null default '{}'::jsonb,
  grocery     jsonb not null default '{}'::jsonb,
  summary     jsonb not null default '{}'::jsonb,
  favorite    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists meal_plans_user_recent
  on public.meal_plans (user_id, updated_at desc);

alter table public.meal_plans enable row level security;
drop policy if exists meal_plans_owner on public.meal_plans;
create policy meal_plans_owner on public.meal_plans
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.meal_plans from anon;
grant select, insert, update, delete on public.meal_plans to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- user_profiles.meal_prefs — the last questionnaire answers, to prefill it.
-- ═══════════════════════════════════════════════════════════════════════
-- No GRANT, on purpose: like daily_calorie_goal, it is read and written only
-- through /api/meal-plan with the service key, so a session token cannot read
-- someone else's diet or allergies.
alter table public.user_profiles
  add column if not exists meal_prefs jsonb;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — expect: meal_plans | true, then meal_prefs | jsonb
-- ═══════════════════════════════════════════════════════════════════════
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename = 'meal_plans';

select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'meal_prefs';
