// /api/make-ingredient.js — the "Make Yourself" feature.
// Given a shop-bought ingredient (bread, pasta, buttermilk, a sauce, stock…),
// returns a short recipe for making it at home. If the ingredient isn't
// something a home cook can reasonably make (salt, a whole chicken, vinegar),
// says so plainly rather than inventing a process.

import { languageInstruction } from '../lib/i18n-data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { ingredient, qty, dish, lang } = req.body || {};
  if (!ingredient || typeof ingredient !== 'string') {
    return res.status(400).json({ error: 'Missing ingredient' });
  }

  const prompt = `You are a practical home-cooking assistant.

A cook is making "${dish || 'a dish'}" and wants to make this ingredient from scratch instead of buying it:
INGREDIENT: ${ingredient}${qty ? `\nAMOUNT NEEDED: ${qty}` : ''}

Decide honestly whether a normal home cook can reasonably make this themselves.

Set "makeable" to false when it is not practical to make at home — raw commodities and whole
proteins (salt, sugar, flour, chicken breast, an onion), or anything needing industrial equipment
or long fermentation with specialist cultures. Do not invent a process for these.

Set "makeable" to true for things people genuinely do make at home: bread, pasta dough, buttermilk,
stock, tomato sauce, pesto, pizza dough, yoghurt, mayonnaise, crème fraîche, spice blends,
breadcrumbs, tortillas, self-raising flour, and similar.

When makeable, scale the recipe to the amount needed, keep it to a handful of ingredients and
short steps, and give a realistic total time (include resting or proving in "time" and mention it
in "note" if it is long).

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{
  "makeable": true,
  "name": "Homemade buttermilk",
  "time": "10 min",
  "difficulty": "Easy",
  "yield": "1 cup",
  "ingredients": [{ "emoji": "🥛", "name": "Whole milk", "qty": "1 cup" }],
  "steps": ["Step one.", "Step two."],
  "note": "One short tip, or an empty string.",
  "reason": ""
}

If makeable is false, return it with empty arrays/strings and put a short friendly explanation in
"reason" (e.g. "Flour is milled from grain — buying it is the practical option.").`;

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
        max_tokens: 1200,
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
    text = text.replace(/```json|```/g, '').trim();
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b !== -1) text = text.slice(a, b + 1);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Parse failure:', text);
      return res.status(200).json({ makeable: false, reason: "Couldn't work that one out — please try again." });
    }

    return res.status(200).json({
      makeable: !!parsed.makeable,
      name: parsed.name || ingredient,
      time: parsed.time || '',
      difficulty: parsed.difficulty || '',
      yield: parsed.yield || '',
      ingredients: Array.isArray(parsed.ingredients) ? parsed.ingredients : [],
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      note: parsed.note || '',
      reason: parsed.reason || ''
    });
  } catch (e) {
    console.error('make-ingredient error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
