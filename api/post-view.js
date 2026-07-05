// /api/post-view.js
// Records a UNIQUE view (one per viewer per post) when a post is opened
// full-screen, and returns the current unique-viewer count.
// Actions:
//   record { post_id }            -> upsert my view, return { count }
//   counts { post_ids: [ids] }    -> return { counts: { post_id: n, ... } }

import { verifyToken } from '../lib/auth.js';

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

  async function countFor(postId) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/post_views?select=id&post_id=eq.${encodeURIComponent(postId)}`, {
      headers: { ...H, 'Prefer': 'count=exact', 'Range': '0-0' }
    });
    const cr = r.headers.get('content-range') || '';
    const total = cr.includes('/') ? parseInt(cr.split('/')[1], 10) : 0;
    return isNaN(total) ? 0 : total;
  }

  try {
    const { action, access_token } = req.body || {};

    if (action === 'counts') {
      const { post_ids } = req.body;
      const counts = {};
      if (Array.isArray(post_ids) && post_ids.length) {
        const pin = encodeURIComponent('(' + post_ids.join(',') + ')');
        // Pull all view rows for these posts and tally in JS (one round trip).
        const r = await fetch(`${SUPABASE_URL}/rest/v1/post_views?select=post_id&post_id=in.${pin}`, { headers: H });
        const rows = r.ok ? await r.json() : [];
        rows.forEach(x => { counts[x.post_id] = (counts[x.post_id] || 0) + 1; });
      }
      return res.status(200).json({ counts });
    }

    if (action === 'record') {
      const { post_id } = req.body;
      if (!post_id) return res.status(400).json({ error: 'Missing post_id.' });
      const me = access_token ? await verifyToken(access_token) : null;
      // Anonymous viewers can't be de-duplicated; just return the count.
      if (!me) return res.status(200).json({ count: await countFor(post_id) });
      // Upsert my view (unique constraint makes repeats a no-op).
      await fetch(`${SUPABASE_URL}/rest/v1/post_views?on_conflict=post_id,viewer_id`, {
        method: 'POST',
        headers: { ...H, 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ post_id, viewer_id: me })
      });
      return res.status(200).json({ count: await countFor(post_id) });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
