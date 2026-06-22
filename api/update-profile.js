// /api/update-profile.js
// Updates a user's profile metadata SERVER-SIDE, so the save goes through
// Vercel's network instead of the user's (sometimes flaky) device connection.
// This mirrors how analyze/support/etc. already talk to Supabase from the server.

export default async function handler(req, res) {
  // CORS
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

  try {
    const { access_token, metadata } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing access token.' });
    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({ error: 'Missing profile data.' });
    }

    // 1) Verify the caller's token and get their user id (so a user can only
    //    update their OWN profile — the token proves who they are).
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${access_token}` }
    });
    if (!whoRes.ok) return res.status(401).json({ error: 'Invalid or expired session.' });
    const user = await whoRes.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Could not verify user.' });

    // 2) Merge new metadata into existing metadata and update via the Admin API.
    const merged = Object.assign({}, user.user_metadata || {}, metadata);
    const updRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_metadata: merged })
    });
    if (!updRes.ok) {
      const detail = await updRes.text().catch(() => '');
      return res.status(502).json({ error: 'Profile update rejected by Supabase.', detail: detail.slice(0, 300) });
    }
    const updated = await updRes.json();
    return res.status(200).json({ ok: true, user_metadata: updated.user_metadata || merged });
  } catch (e) {
    return res.status(500).json({ error: 'Server error updating profile.', detail: String(e && e.message || e).slice(0, 300) });
  }
}
