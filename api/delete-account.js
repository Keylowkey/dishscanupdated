// /api/delete-account.js
// Permanently deletes the caller's account. Posts/comments are KEPT but their
// author is anonymized to "[deleted user]" so threads stay intact.
// Verifies the caller via their own access token before deleting.

import { verifyToken } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  // Anon (public) key — safe to include; it's the same key shipped in the frontend.
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNudnpycXBjYmJseHB5cGFvZW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MzA4OTYsImV4cCI6MjA5NTMwNjg5Nn0.pIVpjNCeKlVpLGyr_PEKECHAbHJvyGjkTZj8jikBshY';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }
  const adminHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const { access_token } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing access token.' });

    // Cryptographically verify the caller's token (HS256) and read their id from it.
    const uid = await verifyToken(access_token);
    if (!uid) return res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });

    // 1) Anonymize their posts so community threads survive as "[deleted user]".
    //    (We blank the username on their profile row; posts read author from it.)
    //    daily_calorie_goal is cleared here too — it is health data, and Play's
    //    Data safety declaration promises deletion covers it.
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ username: '[deleted user]', avatar_photo: null, avatar_icon: null, avatar_color: null, favorites_public: false, daily_calorie_goal: null })
    }).catch(() => {});

    // 2) Delete every row keyed to this user. Anything not listed here outlives
    //    the account, so the list is deliberately exhaustive: leaving the
    //    nutrition log behind would keep health data for an account that no
    //    longer exists, and leaving device_tokens behind would keep pushing
    //    notifications to their phone.
    const del = (path) =>
      fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});
    await Promise.all([
      del(`dishes?user_id=eq.${uid}`),          // history and favorites
      del(`post_reactions?user_id=eq.${uid}`),
      del(`nutrition_log?user_id=eq.${uid}`),   // logged meals — health data
      del(`device_tokens?user_id=eq.${uid}`),   // stop push to their devices
      del(`post_views?viewer_id=eq.${uid}`),
      del(`follows?follower_id=eq.${uid}`),
      del(`follows?following_id=eq.${uid}`),
      del(`blocks?blocker_id=eq.${uid}`),
      del(`blocks?blocked_id=eq.${uid}`),
      del(`shared_recipes?sender_id=eq.${uid}`),
      del(`shared_recipes?recipient_id=eq.${uid}`)
    ]);

    // 3) Delete the auth user itself.
    const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    if (!delRes.ok) {
      const t = await delRes.text().catch(() => '');
      return res.status(502).json({ error: 'Could not delete account.', detail: t.slice(0, 200) });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error deleting account.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
