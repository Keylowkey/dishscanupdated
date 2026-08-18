-- Capture & Cook — daily calorie goal, 16 Aug 2026
-- Run in the Supabase SQL editor. Safe to run more than once.

-- Where each user's daily calorie target lives. Nullable: null means "no goal
-- set", which the tracker shows as a prompt rather than a progress bar.
alter table public.user_profiles
  add column if not exists daily_calorie_goal integer;

-- Keep obviously bad values out at the database level too, not just in the
-- endpoint. 500–10000 kcal covers every real case with room to spare.
alter table public.user_profiles
  drop constraint if exists user_profiles_daily_calorie_goal_range;
alter table public.user_profiles
  add constraint user_profiles_daily_calorie_goal_range
  check (daily_calorie_goal is null or (daily_calorie_goal between 500 and 10000));

-- NOTE: no GRANT is needed for this column. The Aug 15 hardening replaced the
-- table-level grants with per-column ones, and this column is deliberately not
-- in either list — the goal is read and written only through /api/nutrition,
-- which uses service_role. Leaving it ungranted means a session token cannot
-- read other people's targets.

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — expect one row: daily_calorie_goal | integer | YES
-- ═══════════════════════════════════════════════════════════════════════
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_profiles'
  and column_name = 'daily_calorie_goal';
