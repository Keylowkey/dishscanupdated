// lib/post-photos.js — move photos stored inline in posts into Storage.
//
// Posts used to carry their photo as a base64 data: URL in image_url, so the
// feed shipped every photo inside one JSON response (5.8 MB for 21 posts —
// past Vercel's 4.5 MB response cap). New posts upload to the post-photos
// bucket instead. This handles the rest: posts made before that change, and
// posts still coming from app builds that predate it.
//
// Called on posts about to be returned. Each inline photo is uploaded once to
// post-photos/migrated/<post id>.<ext>, the row is updated to point at it, and
// the post in hand is rewritten so this very response is already small. The
// path is deterministic and uploads use upsert, so two requests converting the
// same post at once land on the same file. Any failure leaves that post as it
// was — still displayable, just not yet small.

const BUCKET = 'post-photos';
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Bound the work per request; anything left over converts on the next load.
const MAX_PER_REQUEST = 12;

function parseDataUrl(s) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(s || '');
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!EXT[type]) return null;
  return { type, bytes: Buffer.from(m[2], 'base64') };
}

async function migrateOne(post, SUPABASE_URL, SERVICE_KEY) {
  const parsed = parseDataUrl(post.image_url);
  if (!parsed || !parsed.bytes.length || !post.id) return;
  const path = `migrated/${post.id}.${EXT[parsed.type]}`;
  const auth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': parsed.type, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
    body: parsed.bytes
  });
  if (!up.ok) return;   // bucket missing (migration not run yet) or transient — try again next load

  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  // Only rewrite the row if it still holds the inline photo we uploaded.
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(post.id)}&image_url=like.data%3A*`,
    { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ image_url: url }) }
  );
  if (patch.ok) post.image_url = url;
}

/** Rewrite inline photos in `posts` to Storage URLs, persisting the change. */
export async function moveInlinePhotos(posts, SUPABASE_URL, SERVICE_KEY) {
  if (!Array.isArray(posts) || !SUPABASE_URL || !SERVICE_KEY) return posts;
  const inline = posts.filter(p => p && typeof p.image_url === 'string' && p.image_url.startsWith('data:'));
  await Promise.all(inline.slice(0, MAX_PER_REQUEST).map(p =>
    migrateOne(p, SUPABASE_URL, SERVICE_KEY).catch(() => {})));
  return posts;
}
