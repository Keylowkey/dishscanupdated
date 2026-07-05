// /api/follow-action.js
// Handles all follow-graph writes server-side (works in Chrome — same-origin).
// Actions:
//   follow   { target_id }  -> create follow; 'accepted' if target public, else 'pending'
//   unfollow { target_id }  -> remove my follow of target
//   approve  { follower_id} -> (target = me) approve a pending request
//   decline  { follower_id} -> (target = me) decline/remove a pending request
//   list_requests           -> pending requests aimed at me
//   list_following          -> ids I follow (accepted)

import { verifyToken } from '../lib/auth.js';

const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNudnpycXBjYmJseHB5cGFvZW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MzA4OTYsImV4cCI6MjA5NTMwNjg5Nn0.pIVpjNCeKlVpLGyr_PEKECHAbHJvyGjkTZj8jikBshY';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server missing config.' });
  const H = { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const { access_token, action } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });

    if (action === 'follow') {
      const { target_id } = req.body;
      if (!target_id || target_id === me) return res.status(400).json({ error: 'Bad target.' });
      // Is the target private?
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=is_private&id=eq.${target_id}`, { headers: H });
      const parr = pr.ok ? await pr.json() : [];
      const isPrivate = parr[0] && parr[0].is_private === true;
      const status = isPrivate ? 'pending' : 'accepted';
      // Upsert the follow row.
      const up = await fetch(`${SUPABASE_URL}/rest/v1/follows?on_conflict=follower_id,following_id`, {
        method: 'POST',
        headers: { ...H, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ follower_id: me, following_id: target_id, status })
      });
      if (!up.ok) { const t = await up.text().catch(()=> ''); return res.status(502).json({ error: 'Follow failed.', detail: t.slice(0,200) }); }
      return res.status(200).json({ ok: true, status });
    }

    if (action === 'unfollow') {
      const { target_id } = req.body;
      await fetch(`${SUPABASE_URL}/rest/v1/follows?follower_id=eq.${me}&following_id=eq.${target_id}`, { method: 'DELETE', headers: H });
      return res.status(200).json({ ok: true });
    }

    if (action === 'approve' || action === 'decline') {
      const { follower_id } = req.body;
      if (!follower_id) return res.status(400).json({ error: 'Missing follower_id.' });
      if (action === 'approve') {
        await fetch(`${SUPABASE_URL}/rest/v1/follows?follower_id=eq.${follower_id}&following_id=eq.${me}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ status: 'accepted' })
        });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/follows?follower_id=eq.${follower_id}&following_id=eq.${me}`, { method: 'DELETE', headers: H });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'list_requests') {
      // Pending requests aimed at me, with requester profile info.
      const r = await fetch(`${SUPABASE_URL}/rest/v1/follows?select=follower_id,created_at&following_id=eq.${me}&status=eq.pending&order=created_at.desc`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      let profiles = [];
      if (rows.length) {
        const ids = rows.map(x => x.follower_id);
        const pin = encodeURIComponent('(' + ids.join(',') + ')');
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo&id=in.${pin}`, { headers: H });
        profiles = pr.ok ? await pr.json() : [];
      }
      return res.status(200).json({ requests: rows, profiles });
    }

    if (action === 'list_following') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/follows?select=following_id&follower_id=eq.${me}&status=eq.accepted`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({ following: rows.map(x => x.following_id) });
    }

    if (action === 'follow_status') {
      const { target_id } = req.body;
      if (!target_id) return res.status(400).json({ error: 'Missing target_id.' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/follows?select=status&follower_id=eq.${me}&following_id=eq.${target_id}`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      let state = 'none';
      if (rows[0]) state = rows[0].status === 'pending' ? 'pending' : 'following';
      return res.status(200).json({ state });
    }

    // List the followers OR the following of a given user, with profile info.
    // { action:'list_followers'|'list_following_users', user_id }
    if (action === 'list_followers' || action === 'list_following_users') {
      const { user_id } = req.body;
      const targetUser = user_id || me;
      const col = action === 'list_followers' ? 'following_id' : 'follower_id';
      const otherCol = action === 'list_followers' ? 'follower_id' : 'following_id';
      const r = await fetch(`${SUPABASE_URL}/rest/v1/follows?select=${otherCol}&${col}=eq.${encodeURIComponent(targetUser)}&status=eq.accepted&order=created_at.desc`, { headers: H });
      const rows = r.ok ? await r.json() : [];
      let profiles = [];
      if (rows.length) {
        const ids = rows.map(x => x[otherCol]);
        const pin = encodeURIComponent('(' + ids.join(',') + ')');
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo&id=in.${pin}`, { headers: H });
        profiles = pr.ok ? await pr.json() : [];
      }
      return res.status(200).json({ users: profiles });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
