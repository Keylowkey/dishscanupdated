// /api/user-profile.js
// Returns a user's public profile (avatar, username) and, if they've made their
// favorites public, their favorite dishes. Read server-side so it works in
// Chrome (no direct third-party request to supabase.co).

import { verifyToken } from '../lib/auth.js';
import { moveInlinePhotos } from '../lib/post-photos.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const headers = { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` };

  try {
    const { user_id, access_token } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });

    // Profile (public read)
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo,favorites_public,is_private&id=eq.${encodeURIComponent(user_id)}`,
      { headers }
    );
    const profArr = profRes.ok ? await profRes.json() : [];
    const profile = (profArr && profArr[0]) || null;
    if (!profile) return res.status(404).json({ error: 'User not found.' });

    // Private accounts only expose posts/favorites to the owner or accepted followers.
    const viewerId = access_token ? await verifyToken(access_token) : null;
    let canSeeContent = !(profile.is_private === true) || (viewerId && viewerId === user_id);
    if (!canSeeContent && viewerId) {
      const fr = await fetch(
        `${SUPABASE_URL}/rest/v1/follows?select=id&follower_id=eq.${encodeURIComponent(viewerId)}&following_id=eq.${encodeURIComponent(user_id)}&status=eq.accepted&limit=1`,
        { headers }
      );
      const frows = fr.ok ? await fr.json() : [];
      if (frows.length) canSeeContent = true;
    }

    // A block in either direction hides posts and favorites, as it already
    // does in the feed. The app says "You blocked @x" for the blocker, and
    // only "not available" for the person blocked, so a block isn't revealed.
    let blocked = null;
    if (viewerId && viewerId !== user_id) {
      try {
        const v = encodeURIComponent(viewerId), u = encodeURIComponent(user_id);
        const br = await fetch(
          `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id&or=(and(blocker_id.eq.${v},blocked_id.eq.${u}),and(blocker_id.eq.${u},blocked_id.eq.${v}))`,
          { headers }
        );
        const brows = br.ok ? await br.json() : [];
        if (brows.some(b => b.blocker_id === viewerId)) blocked = 'by_me';
        else if (brows.length) blocked = 'by_them';
      } catch (e) { /* no blocks table or error: treat as none */ }
      if (blocked) canSeeContent = false;
    }

    let favorites = [];
    if (canSeeContent && profile.favorites_public) {
      const favRes = await fetch(
        `${SUPABASE_URL}/rest/v1/dishes?select=id,dish_name,recipe_data,image_url,calories,created_at&user_id=eq.${encodeURIComponent(user_id)}&favorite=eq.true&order=created_at.desc&limit=50`,
        { headers }
      );
      favorites = favRes.ok ? await favRes.json() : [];
    }

    // Follower / following counts (accepted only). Use HEAD + count header.
    async function countRows(filter) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/follows?select=id&${filter}`, {
        headers: { ...headers, 'Prefer': 'count=exact', 'Range': '0-0' }
      });
      const cr = r.headers.get('content-range') || '';
      const total = cr.includes('/') ? parseInt(cr.split('/')[1], 10) : 0;
      return isNaN(total) ? 0 : total;
    }
    let followerCount = 0, followingCount = 0;
    try {
      followerCount = await countRows(`following_id=eq.${encodeURIComponent(user_id)}&status=eq.accepted`);
      followingCount = await countRows(`follower_id=eq.${encodeURIComponent(user_id)}&status=eq.accepted`);
    } catch (e) { /* counts default 0 */ }

    // The user's community posts (newest first). Hidden for private accounts
    // unless the viewer is the owner or an accepted follower.
    let posts = [];
    if (canSeeContent) {
      try {
        const postsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/posts?select=*&user_id=eq.${encodeURIComponent(user_id)}&order=created_at.desc&limit=50`,
          { headers }
        );
        posts = postsRes.ok ? await postsRes.json() : [];
        await moveInlinePhotos(posts, SUPABASE_URL, SERVICE_KEY);
      } catch (e) { /* posts default empty */ }
    }

    return res.status(200).json({
      profile: {
        id: profile.id,
        username: profile.username,
        avatar_color: profile.avatar_color,
        avatar_icon: profile.avatar_icon,
        avatar_photo: profile.avatar_photo,
        favorites_public: profile.favorites_public,
        is_private: profile.is_private === true
      },
      favorites,
      followerCount,
      followingCount,
      posts,
      blocked
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
