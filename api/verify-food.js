// /api/verify-food.js — content gate for anything posted to the community feed.
//
// Originally images only. Text posts went up unchecked, which meant the feed's
// promise ("we check every upload") only held for photos. It now screens both:
//
//   { image_data, media_type }  → must be food, and must be safe
//   { text }                    → must be safe
//   both                        → both are checked
//
// The image response still returns `isFood`, so the version already on the App
// Store keeps working unchanged.

import { guard } from '../lib/guard.js';

const MODEL = 'claude-sonnet-4-5';

// What is never allowed, in a photo or in words. Written once and shared by
// both prompts so the two paths can't drift apart.
const DISALLOWED = `Reject anything that is:
- Sexual or suggestive, nudity, or sexualised content of any kind
- Political: campaigning, partisan advocacy, elections, political figures or
  slogans, protest messaging. (A passing mention of a holiday or a national
  cuisine is NOT political — "grandma's Thanksgiving stuffing" is fine.)
- Criminal or illegal: drugs, weapons, trafficking, theft, fraud, instructions
  for wrongdoing, or content promoting any of it
- Hateful, harassing, or demeaning toward a person or group
- Violent, gory, or self-harm related
- Spam, scams, advertising, or links to off-app commerce`;

async function ask(key, system, content, maxTokens = 250) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, temperature: 0,
      system,
      messages: [{ role: 'user', content }]
    })
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Costs money per call — require a real signed-in account and cap the rate.
  const me = await guard(req, res, { bucket: 'verify-food', max: 80 });
  if (!me) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const { image_data, media_type, text } = req.body || {};
  const caption = typeof text === 'string' ? text.trim() : '';
  if (!image_data && !caption) return res.status(400).json({ error: 'Missing image.' });

  try {
    // ── Words ────────────────────────────────────────────────────────────
    if (caption) {
      const verdict = await ask(ANTHROPIC_KEY,
`You screen short posts on a home-cooking community feed. Almost everything
people write here is fine — a dish, a question, a request for a recipe, chat
about cooking. Allow all of that.

${DISALLOWED}

Judge only what is written. Do not reject a post for being off-topic, badly
written, or in another language — only for the categories above.

Respond ONLY with raw JSON: {"ok": true} or {"ok": false, "reason": "short friendly reason"}`,
        [{ type: 'text', text: caption.slice(0, 2000) }]);

      if (!verdict || verdict.ok !== true) {
        return res.status(200).json({
          ok: false, isFood: false,
          reason: (verdict && verdict.reason) || "That post can't be shared here."
        });
      }
      if (!image_data) return res.status(200).json({ ok: true, isFood: true });
    }

    // ── Photo ────────────────────────────────────────────────────────────
    if (!media_type) return res.status(400).json({ error: 'Missing image.' });
    const verdict = await ask(ANTHROPIC_KEY,
`You are a strict content gate for a food-sharing app. The image must be
primarily a photo of FOOD or DRINK — a dish, meal, ingredients, baked goods,
or a beverage. People may appear incidentally (a hand holding a plate) but food
must be the clear subject.

Also reject, even when food is present:
${DISALLOWED}

Not acceptable either: selfies or portraits, people as the subject, pets,
screenshots, memes, text images, scenery, or unrelated objects.

Respond ONLY with raw JSON: {"isFood": true} or {"isFood": false, "reason": "short friendly reason"}`,
      [
        { type: 'image', source: { type: 'base64', media_type, data: image_data } },
        { type: 'text', text: 'Does this photo pass? JSON only.' }
      ]);

    if (!verdict) {
      return res.status(200).json({
        isFood: false, ok: false,
        reason: 'Could not verify the image. Please try another photo.'
      });
    }
    return res.status(200).json({ ...verdict, ok: verdict.isFood === true });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + String(err.message).slice(0, 200) });
  }
}
