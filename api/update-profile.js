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
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNudnpycXBjYmJseHB5cGFvZW52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MzA4OTYsImV4cCI6MjA5NTMwNjg5Nn0.pIVpjNCeKlVpLGyr_PEKECHAbHJvyGjkTZj8jikBshY';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
  }

  try {
    const { access_token, metadata } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing access token.' });
    if (!metadata || typeof metadata !== 'object') {
      return res.status(400).json({ error: 'Missing profile data.' });
    }

    // 1) Verify the caller's token and get their user id (apikey = anon key).
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${access_token}` }
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

    // 3) ALSO mirror the avatar (+ favorites privacy) to the PUBLIC user_profiles
    //    row so OTHER users can see this person's picture and username.
    try {
      const publicFields = {
        id: user.id,
        user_id: user.id,
        avatar_color: merged.avatar_color || null,
        avatar_icon: merged.avatar_icon || null,
        avatar_photo: merged.avatar_photo || null
      };
      if (typeof merged.username === 'string') publicFields.username = merged.username;
      if (typeof metadata.favorites_public === 'boolean') publicFields.favorites_public = metadata.favorites_public;
      await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?on_conflict=id`, {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(publicFields)
      });
    } catch (e) { /* non-fatal: metadata already saved */ }

    return res.status(200).json({ ok: true, user_metadata: updated.user_metadata || merged });
  } catch (e) {
    return res.status(500).json({ error: 'Server error updating profile.', detail: String(e && e.message || e).slice(0, 300) });
  }
}
