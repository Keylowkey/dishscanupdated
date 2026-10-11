-- Capture & Cook — post photos in Storage, 11 Oct 2026
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- Photos used to be stored as base64 text inside posts.image_url, so every
-- feed load downloaded every photo inside one JSON response (5.8 MB for 21
-- posts, past Vercel's 4.5 MB response cap). They now go to Storage and the
-- post keeps a URL, the same way videos already work.
--
-- image_url  the full photo (≤1024 px), opened in the post viewer.
-- thumb_url  a 720 px version for the feed and profile grid. Null for older
--            posts, which fall back to image_url.
--
-- Existing inline photos, and any still posted by older app builds, are moved
-- into this bucket by /api/community-feed the first time it serves them.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. The column
-- ═══════════════════════════════════════════════════════════════════════
-- No GRANT needed: posts is governed by row-level policies, not column grants.
alter table public.posts
  add column if not exists thumb_url text;

alter table public.posts
  drop constraint if exists posts_thumb_url_ours;
alter table public.posts
  add constraint posts_thumb_url_ours
  check (thumb_url is null
         or thumb_url like 'https://cnvzrqpcbblxpypaoenv.supabase.co/storage/v1/object/public/post-photos/%');

-- ═══════════════════════════════════════════════════════════════════════
-- 2. The bucket
-- ═══════════════════════════════════════════════════════════════════════
-- Public read so the feed can show a photo by URL. 5 MB per file is far above
-- what the app uploads (photos are resized to 1024 px before posting).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-photos', 'post-photos', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Who may write
-- ═══════════════════════════════════════════════════════════════════════
-- Signed-in users write only inside a folder named after their own user id.
-- The server (service role) writes migrated photos under migrated/, which no
-- user can touch.
drop policy if exists "post photos: upload own" on storage.objects;
create policy "post photos: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'post-photos'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "post photos: delete own" on storage.objects;
create policy "post photos: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'post-photos'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY — expect three rows:
--   column   | thumb_url   | text
--   bucket   | post-photos | true
--   policies | 2
-- ═══════════════════════════════════════════════════════════════════════
select 'column' as check, column_name as name, data_type as detail
  from information_schema.columns
 where table_schema = 'public' and table_name = 'posts' and column_name = 'thumb_url'
union all
select 'bucket', id, public::text from storage.buckets where id = 'post-photos'
union all
select 'policies', count(*)::text, '' from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'post photos:%';
