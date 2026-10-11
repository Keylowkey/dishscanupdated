-- Capture & Cook — dish images, 12 Oct 2026
-- Run in the Supabase SQL editor. Safe to run more than once.
--
-- Every recipe shows a picture. Recipes from a photo use that photo; recipes
-- from a search or a video link get one stored here:
--   generated/  made by /api/dish-image with an image AI, one per dish name
--   imports/    the cover of a shared video, kept by /api/import-recipe
--
-- Only the server writes here (with the service key), so no storage policies
-- are needed for users. The bucket is public so the app can show images by URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dish-images', 'dish-images', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- VERIFY — expect one row: dish-images | true
select id, public from storage.buckets where id = 'dish-images';
