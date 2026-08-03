// /api/nutrition.js — server-side nutrition log + profile visibility.
//
// The tracker used to live only in localStorage, which meant nobody else could
// ever see it (and it died with the install). Entries now sync here so a user
// can optionally surface their totals on their profile.
//
// Visibility rules (enforced here, not just in the UI):
//   nutrition_share = false            -> nobody but the owner
//   nutrition_visibility = 'public'    -> any signed-in viewer
//   nutrition_visibility = 'followers' -> only accepted followers (and the owner)
// Blocked users never see anything, in either direction.
//
// Actions:
//   sync   { entries: [...] }  -> upsert the caller's entries, return the merged log
//   log    -> the caller's own full log
//   remove { ts }
//   summary { user_id } -> { allowed, today:{...}, avg7:{...}, days, meals }

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
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  const NUM = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  async function blockedWith(me) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id,blocked_id&or=(blocker_id.eq.${me},blocked_id.eq.${me})`,
        { headers: H });
      if (!r.ok) return new Set();
      return new Set((await r.json()).map(b => (b.blocker_id === me ? b.blocked_id : b.blocker_id)));
    } catch (e) { return new Set(); }
  }

  try {
    const { access_token, action } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });

    if (action === 'sync') {
      const { entries } = req.body;
      if (Array.isArray(entries) && entries.length) {
        const rows = entries.slice(0, 500).map(e => {
          const row = {
            user_id: me,
            ts: Number(e.ts) || Date.now(),
            day: String(e.day || '').slice(0, 10) || dayKey(new Date(Number(e.ts) || Date.now())),
            dish: String(e.dish || 'Meal').slice(0, 160)
          };
          NUM.forEach(k => { row[k] = Number(e[k]) || 0; });
          return row;
        });
        await fetch(`${SUPABASE_URL}/rest/v1/nutrition_log?on_conflict=user_id,ts`, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows)
        });
      }
      // fall through and return the merged log
    }

    if (action === 'sync' || action === 'log') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/nutrition_log?select=*&user_id=eq.${me}&order=ts.desc&limit=1000`,
        { headers: H });
      return res.status(200).json({ entries: r.ok ? await r.json() : [] });
    }

    if (action === 'remove') {
      const { ts } = req.body;
      if (!ts) return res.status(400).json({ error: 'Missing ts.' });
      await fetch(`${SUPABASE_URL}/rest/v1/nutrition_log?user_id=eq.${me}&ts=eq.${encodeURIComponent(ts)}`,
        { method: 'DELETE', headers: H });
      return res.status(200).json({ ok: true });
    }

    if (action === 'summary') {
      const { user_id } = req.body;
      const target = user_id || me;
      const isMe = target === me;

      if (!isMe) {
        const blocked = await blockedWith(me);
        if (blocked.has(target)) return res.status(200).json({ allowed: false, reason: 'blocked' });
      }

      // Owner always sees their own; everyone else goes through the settings.
      let allowed = isMe;
      if (!isMe) {
        const pr = await fetch(
          `${SUPABASE_URL}/rest/v1/user_profiles?select=nutrition_share,nutrition_visibility,is_private&id=eq.${encodeURIComponent(target)}`,
          { headers: H });
        const prof = (pr.ok ? await pr.json() : [])[0] || {};
        if (prof.nutrition_share === true) {
          // A private account hides everything from non-followers, so "Everyone"
          // still means "accepted followers" there — otherwise nutrition would
          // leak past a lock that's hiding their posts.
          const needsFollow = prof.nutrition_visibility === 'followers' || prof.is_private === true;
          if (needsFollow) {
            const fr = await fetch(
              `${SUPABASE_URL}/rest/v1/follows?select=id&follower_id=eq.${me}&following_id=eq.${encodeURIComponent(target)}&status=eq.accepted&limit=1`,
              { headers: H });
            allowed = fr.ok ? (await fr.json()).length > 0 : false;
          } else {
            allowed = true;   // public account, shared publicly
          }
        }
      }
      if (!allowed) return res.status(200).json({ allowed: false });

      // Last 7 days including today.
      const since = new Date(); since.setDate(since.getDate() - 6);
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/nutrition_log?select=*&user_id=eq.${encodeURIComponent(target)}&day=gte.${dayKey(since)}&limit=1000`,
        { headers: H });
      const rows = r.ok ? await r.json() : [];

      const today = dayKey(new Date());
      const sum = (list) => {
        const o = {}; NUM.forEach(k => { o[k] = 0; });
        list.forEach(e => NUM.forEach(k => { o[k] += Number(e[k]) || 0; }));
        NUM.forEach(k => { o[k] = Math.round(o[k]); });
        return o;
      };
      const todayRows = rows.filter(e => e.day === today);
      const weekTotals = sum(rows);
      // Average across days that actually have entries, so a rest day doesn't
      // drag the average down misleadingly.
      const activeDays = new Set(rows.map(e => e.day)).size || 1;
      const avg7 = {}; NUM.forEach(k => { avg7[k] = Math.round(weekTotals[k] / activeDays); });

      return res.status(200).json({
        allowed: true,
        today: sum(todayRows),
        avg7,
        days: activeDays,
        meals: rows.length,
        todayMeals: todayRows.length
      });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
