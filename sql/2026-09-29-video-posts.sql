-- Capture & Cook — video posts, 29 Sep 2026
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- Photos are stored as base64 inside posts.image_url. That cannot work for
-- video, which runs to tens of megabytes, so video files go to Supabase
-- Storage and the post keeps only their URL.
--
-- A video post still fills image_url, with a still frame. Older app builds,
-- including the one live on the App Store, know nothing about video_url and
-- will show that frame as an ordinary photo post rather than a broken one.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The column
-- ═══════════════════════════════════════════════════════════════════════
-- No GRANT needed: posts is governed by row-level policies (posts_visible,
-- posts_insert_own, …), not per-column grants, so the new column follows the
-- same rules as the rest of the row, private accounts included.
alter table public.posts
  add column if not exists video_url text;

-- Only our own storage bucket, never an arbitrary link.
alter table public.posts
  drop constraint if exists posts_video_url_ours;
alter table public.posts
  add constraint posts_video_url_ours
  check (video_url is null
         or video_url like 'https://cnvzrqpcbblxpypaoenv.supabase.co/storage/v1/object/public/post-videos/%');

-- ═══════════════════════════════════════════════════════════════════════
-- 2. The bucket
-- ═══════════════════════════════════════════════════════════════════════
-- Public read, so the feed can stream a video by URL. 50 MB per file, which
-- is also the Supabase free-plan ceiling. Common phone formats only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-videos', 'post-videos', true, 52428800,
        array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Who may write
-- ═══════════════════════════════════════════════════════════════════════
-- Signed-in users write only inside a folder named after their own user id,
-- e.g. post-videos/<uid>/1727…-a1b2.mp4. Reading needs no policy because the
-- bucket is public.
drop policy if exists "post videos: upload own" on storage.objects;
create policy "post videos: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'post-videos'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "post videos: delete own" on storage.objects;
create policy "post videos: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-videos'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — expect three rows:
--   column   | video_url   | text
--   bucket   | post-videos | true
--   policies | 2
-- ═══════════════════════════════════════════════════════════════════════
select 'column' as check, column_name as name, data_type as detail
  from information_schema.columns
 where table_schema = 'public' and table_name = 'posts' and column_name = 'video_url'
union all
select 'bucket', id, public::text from storage.buckets where id = 'post-videos'
union all
select 'policies', count(*)::text, '' from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'post videos:%';
