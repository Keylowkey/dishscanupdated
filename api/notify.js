// /api/notify.js — client-triggered notifications (comments, mentions, reactions).
//
// These used to be inserted straight from the app with the anon key, which
// meant they only ever lit up the in-app bell — no push, so nothing arrived
// while the app was closed. Routing them here lets the server push as well,
// and lets it verify the sender is who they claim to be.

import { verifyToken } from '../lib/auth.js';
import { notifyAll } from '../lib/notify.js';

const ALLOWED = new Set(['comment', 'mention', 'reaction']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server missing config.' });
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const { access_token, rows } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows.' });

    // Sender identity comes from the verified token, never the request body.
    let username = null;
    try {
      const ur = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=username&id=eq.${me}`, { headers: H });
      const arr = ur.ok ? await ur.json() : [];
      username = (arr[0] && arr[0].username) || null;
    } catch (e) { /* optional */ }

    // Don't let anyone notify people who blocked them, or notify themselves.
    let blocked = new Set();
    try {
      const br = await fetch(
        `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id,blocked_id&or=(blocker_id.eq.${me},blocked_id.eq.${me})`,
        { headers: H });
      if (br.ok) blocked = new Set((await br.json()).map(b => (b.blocker_id === me ? b.blocked_id : b.blocker_id)));
    } catch (e) { /* ignore */ }

    const clean = rows
      .filter(r => r && r.recipient_id && ALLOWED.has(r.type))
      .filter(r => r.recipient_id !== me && !blocked.has(r.recipient_id))
      .slice(0, 50)
      .map(r => ({
        recipient_id: r.recipient_id,
        actor_id: me,
        actor_username: username,
        type: r.type,
        post_id: r.post_id || null,
        reaction_type: r.reaction_type || null,
        preview: r.preview ? String(r.preview).slice(0, 120) : null
      }));

    if (!clean.length) return res.status(200).json({ ok: true, inserted: 0, pushed: 0 });
    const out = await notifyAll({ SUPABASE_URL, headers: H }, clean);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
