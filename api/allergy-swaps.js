// /api/allergy-swaps.js — suggests allergen-free substitutions for a recipe.
// Given a dish, its ingredients, and the flagged allergens, asks Claude to
// return JSON with: per-ingredient swaps, an optional alternative dish, and a
// noReplacements flag when nothing close exists.
import { languageInstruction } from '../lib/i18n-data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { dish, ingredients, allergens, lang } = req.body || {};
  if (!Array.isArray(ingredients) || !Array.isArray(allergens) || !allergens.length) {
    return res.status(400).json({ error: 'Missing dish, ingredients, or allergens' });
  }

  const prompt = `You are a helpful culinary assistant focused on food allergies and dietary needs.

Dish: "${dish || 'this dish'}"
Ingredients: ${ingredients.join(', ')}
Allergens to avoid: ${allergens.join(', ')}

For EACH ingredient that contains or is one of the flagged allergens, suggest a safe, commonly available substitution that preserves the dish as much as possible.

Rules:
- If a good direct substitution exists, give it (e.g. dairy milk -> oat milk; wheat flour -> 1:1 gluten-free flour blend; egg -> flax egg).
- If an ingredient genuinely cannot be reasonably substituted while keeping the dish recognizable, set its "replacement" to "none".
- If one or more ingredients can't be swapped, suggest ONE alternative dish that is similar in flavor/spirit but naturally avoids the flagged allergens. Put it in "alternativeDish" as a short sentence.
- If there is no reasonably close alternative dish either, set "alternativeDish" to "none" and "noReplacements" to true.
- Keep notes short (one sentence max).

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{
  "swaps": [
    { "allergen": "Dairy", "ingredient": "butter", "replacement": "olive oil or vegan butter", "note": "Use the same amount." }
  ],
  "alternativeDish": "A short sentence, or \\"none\\".",
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
      return res.status(200).json({ swaps: [], alternativeDish: 'none', noReplacements: true });
    }

    // Normalize shape
    return res.status(200).json({
      swaps: Array.isArray(parsed.swaps) ? parsed.swaps : [],
      alternativeDish: parsed.alternativeDish || 'none',
      noReplacements: !!parsed.noReplacements,
    });
  } catch (e) {
    console.error('allergy-swaps error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
