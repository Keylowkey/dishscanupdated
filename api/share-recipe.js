// /api/share-recipe.js — share a recipe with people who follow you.
//
// Sharing rule (enforced server-side, not just in the UI):
//   You may share with anyone who FOLLOWS you (status 'accepted').
//   Mutuals are a subset of that, so they're included automatically.
//   People you follow who don't follow you back are NOT valid recipients.
//
// Actions:
//   list_recipients            -> your accepted followers (minus anyone blocked either way)
//   share { recipient_ids, recipe, dish_name, image_url }
//   list_received              -> recipes shared with you (newest first)
//   mark_read { id }
//   delete_received { id }

import { verifyToken } from '../lib/auth.js';
import { notifyAll } from '../lib/notify.js';

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

  // Everyone who follows `me` and isn't blocked in either direction.
  async function eligibleRecipients(me) {
    const fr = await fetch(
      `${SUPABASE_URL}/rest/v1/follows?select=follower_id&following_id=eq.${me}&status=eq.accepted`,
      { headers: H }
    );
    let ids = fr.ok ? (await fr.json()).map(r => r.follower_id) : [];
    if (!ids.length) return [];
    try {
      const br = await fetch(
        `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id,blocked_id&or=(blocker_id.eq.${me},blocked_id.eq.${me})`,
        { headers: H }
      );
      if (br.ok) {
        const blocked = new Set((await br.json()).map(b => (b.blocker_id === me ? b.blocked_id : b.blocker_id)));
        ids = ids.filter(id => !blocked.has(id));
      }
    } catch (e) { /* no blocks table -> nothing to filter */ }
    return ids;
  }

  try {
    const { access_token, action } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });

    if (action === 'list_recipients') {
      const ids = await eligibleRecipients(me);
      if (!ids.length) return res.status(200).json({ recipients: [] });
      const pin = encodeURIComponent('(' + ids.join(',') + ')');
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,avatar_color,avatar_icon,avatar_photo&id=in.${pin}`,
        { headers: H }
      );
      const profiles = pr.ok ? await pr.json() : [];
      // Flag mutuals so the UI can label them.
      const mr = await fetch(
        `${SUPABASE_URL}/rest/v1/follows?select=following_id&follower_id=eq.${me}&status=eq.accepted`,
        { headers: H }
      );
      const iFollow = new Set(mr.ok ? (await mr.json()).map(r => r.following_id) : []);
      profiles.forEach(p => { p.mutual = iFollow.has(p.id); });
      return res.status(200).json({ recipients: profiles });
    }

    if (action === 'share') {
      const { recipient_ids, recipe, dish_name, image_url } = req.body;
      if (!Array.isArray(recipient_ids) || !recipient_ids.length) {
        return res.status(400).json({ error: 'Pick at least one person.' });
      }
      if (!recipe || typeof recipe !== 'object') {
        return res.status(400).json({ error: 'Missing recipe.' });
      }
      // Enforce the rule: drop anyone who doesn't actually follow me.
      const allowed = new Set(await eligibleRecipients(me));
      const valid = recipient_ids.filter(id => allowed.has(id) && id !== me);
      if (!valid.length) {
        return res.status(403).json({ error: 'You can only share with people who follow you.' });
      }

      // Sender's username, for the notification text.
      let username = null;
      try {
        const ur = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=username&id=eq.${me}`, { headers: H });
        const arr = ur.ok ? await ur.json() : [];
        username = (arr[0] && arr[0].username) || null;
      } catch (e) { /* optional */ }

      // Keep the payload sane — a base64 thumb can be large.
      const thumb = (typeof image_url === 'string' && image_url.length < 400000) ? image_url : null;
      const name = String(dish_name || recipe.dish || 'A recipe').slice(0, 120);

      const rows = valid.map(rid => ({
        sender_id: me,
        sender_username: username,
        recipient_id: rid,
        dish_name: name,
        recipe_data: recipe,
        image_url: thumb
      }));
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/shared_recipes`, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify(rows)
      });
      if (!ins.ok) {
        const t = await ins.text().catch(() => '');
        return res.status(502).json({ error: 'Could not share.', detail: t.slice(0, 200) });
      }

      await notifyAll({ SUPABASE_URL, headers: H }, valid.map(rid => ({
        recipient_id: rid,
        actor_id: me,
        actor_username: username,
        type: 'recipe',
        preview: name
      })));

      return res.status(200).json({ ok: true, sent: valid.length, skipped: recipient_ids.length - valid.length });
    }

    if (action === 'list_received') {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/shared_recipes?select=id,sender_id,sender_username,dish_name,recipe_data,image_url,is_read,created_at&recipient_id=eq.${me}&order=created_at.desc&limit=100`,
        { headers: H }
      );
      let rows = r.ok ? await r.json() : [];
      // Hide anything from someone since blocked.
      try {
        const br = await fetch(
          `${SUPABASE_URL}/rest/v1/blocks?select=blocker_id,blocked_id&or=(blocker_id.eq.${me},blocked_id.eq.${me})`,
          { headers: H }
        );
        if (br.ok) {
          const blocked = new Set((await br.json()).map(b => (b.blocker_id === me ? b.blocked_id : b.blocker_id)));
          rows = rows.filter(x => !blocked.has(x.sender_id));
        }
      } catch (e) { /* ignore */ }
      return res.status(200).json({ received: rows });
    }

    if (action === 'mark_read') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id.' });
      await fetch(`${SUPABASE_URL}/rest/v1/shared_recipes?id=eq.${encodeURIComponent(id)}&recipient_id=eq.${me}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ is_read: true })
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_received') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id.' });
      await fetch(`${SUPABASE_URL}/rest/v1/shared_recipes?id=eq.${encodeURIComponent(id)}&recipient_id=eq.${me}`, {
        method: 'DELETE', headers: H
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
