// /api/ingredient-swaps.js — the "Don't Have?" feature.
// Given a dish and the ingredients the user is missing, asks Claude for
// common household substitutes that still produce the same dish. Mirrors
// allergy-swaps.js. Returns { swaps: [{ingredient, replacement, note}],
// noReplacements } — replacement is "none" when nothing works.
import { languageInstruction } from '../lib/i18n-data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { dish, ingredients, missing, lang } = req.body || {};
  if (!Array.isArray(ingredients) || !Array.isArray(missing) || !missing.length) {
    return res.status(400).json({ error: 'Missing dish, ingredients, or missing list' });
  }

  const prompt = `You are a practical home-cooking assistant.

Dish: "${dish || 'this dish'}"
Full ingredient list: ${ingredients.join(', ')}
Ingredients the cook does NOT have: ${missing.join(', ')}

For EACH missing ingredient, suggest a commonly available substitute (something people often already have at home) that still produces essentially the same dish.

Rules:
- Prefer pantry-staple substitutes and simple combinations (e.g. buttermilk -> milk + a splash of lemon juice; brown sugar -> white sugar + molasses, or just white sugar).
- The dish must remain recognizably the same dish with the substitute.
- If a missing ingredient genuinely has no reasonable substitute for this dish (it IS the dish, e.g. chicken in roast chicken), set its "replacement" to "none".
- If NONE of the missing ingredients can be substituted, set "noReplacements" to true.
- Keep notes short (one sentence max, include rough quantities when helpful).

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{
  "swaps": [
    { "ingredient": "buttermilk", "replacement": "1 cup milk + 1 tbsp lemon juice", "note": "Let it sit 5 minutes before using." }
  ],
  "noReplacements": false
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt + languageInstruction(lang) }],
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error('Anthropic error:', txt);
      return res.status(502).json({ error: 'AI request failed' });
    }

    const data = await r.json();
    let text = (data.content && data.content[0] && data.content[0].text) || '';
    // Strip accidental code fences and isolate the JSON object
    text = text.replace(/```json|```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) text = text.slice(start, end + 1);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Parse failure:', text);
      return res.status(200).json({ swaps: [], noReplacements: true });
    }

    const swaps = Array.isArray(parsed.swaps) ? parsed.swaps : [];
    // noReplacements is also true when every suggestion came back "none".
    const allNone = swaps.length > 0 && swaps.every(s => String(s.replacement || 'none').toLowerCase() === 'none');
    return res.status(200).json({
      swaps,
      noReplacements: !!parsed.noReplacements || allNone || swaps.length === 0,
    });
  } catch (e) {
    console.error('ingredient-swaps error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
