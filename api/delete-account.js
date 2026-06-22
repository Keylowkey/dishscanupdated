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

    // Verify caller identity from their token.
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${access_token}` }
    });
    if (!whoRes.ok) return res.status(401).json({ error: 'Invalid or expired session.' });
    const user = await whoRes.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'Could not verify user.' });

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
