// /api/user-profile.js
// Returns a user's public profile (avatar, username) and, if they've made their
// favorites public, their favorite dishes. Read server-side so it works in
// Chrome (no direct third-party request to supabase.co).

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
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });

    // Profile (public read)
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo,favorites_public&id=eq.${encodeURIComponent(user_id)}`,
      { headers }
    );
    const profArr = profRes.ok ? await profRes.json() : [];
    const profile = (profArr && profArr[0]) || null;
    if (!profile) return res.status(404).json({ error: 'User not found.' });

    let favorites = [];
    if (profile.favorites_public) {
      const favRes = await fetch(
        `${SUPABASE_URL}/rest/v1/dishes?select=id,dish_name,recipe_data,image_url,calories,created_at&user_id=eq.${encodeURIComponent(user_id)}&favorite=eq.true&order=created_at.desc&limit=50`,
        { headers }
      );
      favorites = favRes.ok ? await favRes.json() : [];
    }

    return res.status(200).json({
      profile: {
        id: profile.id,
        username: profile.username,
        avatar_color: profile.avatar_color,
        avatar_icon: profile.avatar_icon,
        avatar_photo: profile.avatar_photo,
        favorites_public: profile.favorites_public
      },
      favorites
    });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
