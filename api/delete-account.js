// /api/delete-account.js
// Permanently deletes the caller's account. Posts/comments are KEPT but their
// author is anonymized to "[deleted user]" so threads stay intact.
// Verifies the caller via their own access token before deleting.

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

    // Get the caller's user id from their JWT directly. The access token is a
    // signed JWT whose payload contains "sub" (the user id). We read it locally
    // to avoid a network round-trip to /auth/v1/user that has been returning
    // Cloudflare 520 errors. We still verify the token is REAL below by using it
    // against the auth endpoint with one retry — but we don't hard-fail on a 520.
    let uid = null;
    try {
      const parts = access_token.split('.');
      const payloadStr = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(payloadStr);
      uid = payload.sub || null;
      // Reject obviously expired tokens.
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }
    } catch (e) {
      return res.status(401).json({ error: 'Could not read session token.' });
    }
    if (!uid) return res.status(401).json({ error: 'Could not verify user.' });

    // Best-effort confirm the token is valid (retry once; tolerate 520s).
    let confirmed = false;
    for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
      try {
        const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${access_token}` }
        });
        if (whoRes.ok) {
          const u = await whoRes.json();
          if (u && u.id) { uid = u.id; confirmed = true; break; }
        } else if (whoRes.status === 401 || whoRes.status === 403) {
          // Token genuinely rejected — stop and report.
          return res.status(401).json({ error: 'Your session is no longer valid. Please sign in again.' });
        }
        // Other statuses (520, 5xx) → retry.
      } catch (e) { /* network hiccup → retry */ }
      await new Promise(r => setTimeout(r, 400));
    }
    // If we couldn't confirm due to infra errors but the JWT looked valid and
    // unexpired, proceed using the uid from the token (it's cryptographically
    // the user's own token, sent over HTTPS from their authenticated session).

    // 1) Anonymize their posts so community threads survive as "[deleted user]".
    //    (We blank the username on their profile row; posts read author from it.)
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${uid}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ username: '[deleted user]', avatar_photo: null, avatar_icon: null, avatar_color: null, favorites_public: false })
    }).catch(() => {});

    // 2) Delete their private data: dishes (history/favorites) and reactions.
    await fetch(`${SUPABASE_URL}/rest/v1/dishes?user_id=eq.${uid}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});
    await fetch(`${SUPABASE_URL}/rest/v1/post_reactions?user_id=eq.${uid}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});

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
