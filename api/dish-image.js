// /api/dish-image.js — return an image URL for a dish, creating it if needed.
//
// POST { dish, ingredients? } → { url, generated }
//
// The first request for a dish name asks the image AI for a realistic photo
// of it and stores the result; every later request for that name, from any
// user, gets the stored file at no cost (see lib/dish-images.js).
//
// Env: OPENAI_API_KEY (required)
//      OPENAI_IMAGE_MODEL   default gpt-image-2.5-flare
//      OPENAI_IMAGE_QUALITY default medium
//
// Without a key this answers 503 and the app simply shows no image, so it can
// be deployed before the key is added.

import { guard } from '../lib/guard.js';
import { dishKey, exists, publicUrl, store } from '../lib/dish-images.js';

const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare';
const QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

function prompt(dish, ingredients) {
  const main = (Array.isArray(ingredients) ? ingredients : [])
    .map(i => (i && typeof i === 'object' ? i.name : i))
    .filter(n => typeof n === 'string' && n.trim())
    .slice(0, 6).map(n => n.trim().slice(0, 40)).join(', ');
  return `A realistic, appetizing food photograph of ${dish}` +
    (main ? `, made with ${main}` : '') +
    `. Plated and ready to eat, shown as a home cook would serve it. Natural window light, ` +
    `slightly overhead angle, shallow depth of field, on a simple table. ` +
    `Photographic, not illustrated. No text, no labels, no logos, no hands, no people.`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { dish, ingredients } = req.body || {};
  const name = typeof dish === 'string' ? dish.trim().slice(0, 120) : '';
  const key = dishKey(name);
  if (!key) return res.status(400).json({ error: 'Missing dish' });
  const path = `generated/${key}.jpg`;

  // Already made: free, and needs no rate-limit budget.
  if (await exists(SUPABASE_URL, path)) {
    return res.status(200).json({ url: publicUrl(SUPABASE_URL, path), generated: false });
  }
  if (!OPENAI_KEY) return res.status(503).json({ error: 'Dish images are not set up yet.' });

  // Making one costs money: signed-in users only past the anonymous share.
  const me = await guard(req, res, { bucket: 'dish-image', max: 40 });
  if (!me) return;

  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: prompt(name, ingredients),
        n: 1,
        size: '1024x1024',
        quality: QUALITY,
        output_format: 'jpeg',
        output_compression: 82
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('OpenAI image error:', r.status, t.slice(0, 300));
      return res.status(502).json({ error: 'Could not create an image for this dish.' });
    }
    const out = await r.json();
    const b64 = out && out.data && out.data[0] && out.data[0].b64_json;
    if (!b64) return res.status(502).json({ error: 'Could not create an image for this dish.' });

    const url = await store(SUPABASE_URL, SERVICE_KEY, path, Buffer.from(b64, 'base64'));
    if (!url) return res.status(502).json({ error: 'Could not save the image.' });
    return res.status(200).json({ url, generated: true });
  } catch (e) {
    console.error('dish-image error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
