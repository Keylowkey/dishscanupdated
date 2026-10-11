// lib/dish-images.js — a picture for every dish.
//
// Recipes from a photo already have one. Recipes from a search or a video
// link did not, so the recipe page and History showed a blank square. Their
// image now lives in the public `dish-images` bucket:
//
//   generated/<slug>-<hash>.jpg   made by /api/dish-image with an image AI,
//                                 one per dish name, reused by everyone who
//                                 gets that dish (so each costs once)
//   imports/<hash>.jpg            the cover of a shared video, kept by
//                                 /api/import-recipe, because the platform's
//                                 own image URL expires within days
//
// Paths are deterministic and uploads use upsert, so two requests for the
// same dish at once land on the same file.

import crypto from 'node:crypto';

export const BUCKET = 'dish-images';

// The cache key: case, accents, punctuation and spacing don't make a
// different dish. Non-Latin names (Arabic, Hindi) hash to a stable key too.
export function dishKey(name) {
  const norm = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!norm) return null;
  const slug = norm.replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '-').slice(0, 60);
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
  return (slug ? slug + '-' : '') + hash;
}

export function publicUrl(SUPABASE_URL, path) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** True if the file is already in the bucket (public, so a HEAD is enough). */
export async function exists(SUPABASE_URL, path) {
  try {
    const r = await fetch(publicUrl(SUPABASE_URL, path), { method: 'HEAD' });
    return r.ok;
  } catch (e) { return false; }
}

/** Upload bytes with the service key. Returns the public URL, or null. */
export async function store(SUPABASE_URL, SERVICE_KEY, path, bytes, contentType = 'image/jpeg') {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000'
    },
    body: bytes
  });
  if (!r.ok) {
    console.error('dish-images store failed:', r.status, (await r.text().catch(() => '')).slice(0, 160));
    return null;
  }
  return publicUrl(SUPABASE_URL, path);
}
