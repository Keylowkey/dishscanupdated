// /api/community-feed.js
// Reads the community feed (posts + reactions) SERVER-SIDE so the browser never
// makes a direct (third-party) request to supabase.co — which Chrome blocks by
// default via third-party cookie/request restrictions. Mirrors how Cook/Takeout
// already talk to Supabase from the server.

import { verifyToken } from '../lib/auth.js';

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

  const headers = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // Identify the caller (optional) so we can mark which reactions are theirs.
    let callerId = null;
    const { access_token, mode } = req.body || {};
    if (access_token) callerId = await verifyToken(access_token); // invalid/forged → treated as anonymous

    // Blocks (both directions): users the caller blocked, and users who blocked
    // the caller, are mutually invisible in the feed.
    let blockedIds = [];
    if (callerId) {
      try {
        const br = await fetch(
          `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id,blocked_id&or=(blocker_id.eq.${callerId},blocked_id.eq.${callerId})`,
          { headers }
        );
        const brows = br.ok ? await br.json() : [];
        blockedIds = [...new Set(brows.map(b => b.blocker_id === callerId ? b.blocked_id : b.blocker_id))];
      } catch (e) { /* no blocks table yet or error → treat as none */ }
    }
    const blockedSet = new Set(blockedIds);

    // If "following" mode, get the ids the caller follows (accepted only).
    // Returns an empty feed if they follow no one.
    let followingIds = null;
    if (mode === 'following') {
      if (!callerId) return res.status(200).json({ posts: [], reactions: [], profiles: [], callerId, mode });
      const fr = await fetch(
        `${SUPABASE_URL}/rest/v1/follows?select=following_id&follower_id=eq.${callerId}&status=eq.accepted`,
        { headers }
      );
      const frows = fr.ok ? await fr.json() : [];
      followingIds = frows.map(x => x.following_id).filter(id => !blockedSet.has(id));
      if (!followingIds.length) {
        return res.status(200).json({ posts: [], reactions: [], profiles: [], callerId, mode, blockedIds });
      }
    }

    // 1) Posts (newest first, limit 50) — filtered to followed users in "following" mode.
    let postsUrl = `${SUPABASE_URL}/rest/v1/posts?select=*&order=created_at.desc&limit=50`;
    if (followingIds) {
      const inList = encodeURIComponent('(' + followingIds.join(',') + ')');
      postsUrl = `${SUPABASE_URL}/rest/v1/posts?select=*&user_id=in.${inList}&order=created_at.desc&limit=50`;
    }
    const postsRes = await fetch(postsUrl, { headers });
    if (!postsRes.ok) {
      const t = await postsRes.text().catch(() => '');
      return res.status(502).json({ error: 'Could not read posts.', detail: t.slice(0, 200) });
    }
    let posts = await postsRes.json();
    if (Array.isArray(posts) && blockedSet.size) {
      posts = posts.filter(p => !blockedSet.has(p.user_id));
    }

    // Private accounts must not surface in the public feed to non-followers.
    // (user-profile.js already gated the profile view; the feed did not, so
    // their posts were still readable by anyone.)
    if (Array.isArray(posts) && posts.length) {
      const authorIds0 = [...new Set(posts.map(p => p.user_id).filter(Boolean))];
      const pin0 = encodeURIComponent('(' + authorIds0.join(',') + ')');
      const privRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,is_private&id=in.${pin0}`, { headers }
      );
      const privRows = privRes.ok ? await privRes.json() : [];
      const privateIds = new Set(privRows.filter(p => p.is_private === true).map(p => p.id));
      if (privateIds.size) {
        let allowed = new Set();
        if (callerId) {
          allowed.add(callerId);   // always see your own
          const fr2 = await fetch(
            `${SUPABASE_URL}/rest/v1/follows?select=following_id&follower_id=eq.${callerId}&status=eq.accepted`,
            { headers }
          );
          if (fr2.ok) (await fr2.json()).forEach(r => allowed.add(r.following_id));
        }
        posts = posts.filter(p => !privateIds.has(p.user_id) || allowed.has(p.user_id));
      }
    }

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(200).json({ posts: [], reactions: [], profiles: [], callerId, mode, blockedIds });
    }

    // 2) Reactions for those posts
    const ids = posts.map(p => p.id);
    const inList = encodeURIComponent('(' + ids.join(',') + ')');
    const reactRes = await fetch(
      `${SUPABASE_URL}/rest/v1/post_reactions?select=post_id,user_id,type&post_id=in.${inList}`,
      { headers }
    );
    const reactions = reactRes.ok ? await reactRes.json() : [];

    // 3) Author profiles (public) so every post shows the author's CURRENT
    //    avatar + username, visible to everyone.
    const authorIds = [...new Set(posts.map(p => p.user_id).filter(Boolean))];
    let profiles = [];
    if (authorIds.length) {
      const pin = encodeURIComponent('(' + authorIds.join(',') + ')');
      const profRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo&id=in.${pin}`,
        { headers }
      );
      profiles = profRes.ok ? await profRes.json() : [];
    }

    return res.status(200).json({ posts, reactions, profiles, callerId, blockedIds });
  } catch (e) {
    return res.status(500).json({ error: 'Server error reading feed.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
