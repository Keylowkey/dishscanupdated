// /api/adapt-method.js — rewrite a recipe's method for a different appliance.
//
// A recipe names its main heating appliance and the alternatives that would
// work (lib/recipe-extras.js). When the cook picks one, this returns steps,
// equipment and total time rewritten for it. Ingredients and quantities stay
// the same, so nutrition, cost and servings are untouched.
//
// It runs only when someone actually switches, which keeps the initial recipe
// as fast to generate as it was before.

import { languageInstruction } from '../lib/i18n-data.js';
import { guard } from '../lib/guard.js';

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const me = await guard(req, res, { bucket: 'adapt-method', max: 60 });
  if (!me) return;

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { recipe, equipment, lang } = req.body || {};
  const target = clip(equipment, 60).trim();
  if (!target) return res.status(400).json({ error: 'Missing equipment' });
  if (!recipe || typeof recipe !== 'object' || !Array.isArray(recipe.steps) || !recipe.steps.length) {
    return res.status(400).json({ error: 'Missing recipe' });
  }

  // Only what the rewrite needs, bounded — this arrives from the client.
  const dish = clip(recipe.dish, 120);
  const from = clip(recipe.cookingEquipment && recipe.cookingEquipment.primary, 60);
  const ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
    .slice(0, 20).map(i => `- ${clip(i && i.qty, 40)} ${clip(i && i.name, 80)}`.trim()).join('\n');
  const tools = (Array.isArray(recipe.equipment) ? recipe.equipment : [])
    .slice(0, 10).map(e => clip(e && e.name, 60)).filter(Boolean).join(', ');
  const steps = recipe.steps.slice(0, 12).map((s, i) => `${i + 1}. ${clip(s, 500)}`).join('\n');

  const prompt = `You are an expert home cook. Rewrite this recipe's method so it is cooked with a different appliance.

DISH: ${dish}
ORIGINAL APPLIANCE: ${from || 'not stated'}
NEW APPLIANCE: ${target}
OTHER TOOLS: ${tools || 'not stated'}

INGREDIENTS (do not change these or their amounts):
${ingredients || '- not stated'}

ORIGINAL STEPS:
${steps}

Rewrite the steps for the new appliance. Change temperatures, times, preheating, technique and doneness cues as that appliance needs. Keep prep steps that don't depend on the appliance. Keep the same ingredients and quantities. In the equipment list, replace the original appliance with the new one and keep the other tools that are still used.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"time":"25 min","equipment":[{"emoji":"🌀","name":"Air fryer"},{"emoji":"🔪","name":"Chef's knife"}],"steps":["Step one.","Step two."],"note":"One short sentence on how the result differs from the original, or an empty string."}

Use 4 to 7 steps.`;

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
        max_tokens: 1500,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt + languageInstruction(lang) }],
      }),
    });

    if (!r.ok) {
      console.error('Anthropic error:', await r.text());
      return res.status(502).json({ error: 'Could not rewrite the method. Please try again.' });
    }

    const data = await r.json();
    let text = (data.content && data.content[0] && data.content[0].text) || '';
    text = text.replace(/```json|```/g, '').trim();
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b !== -1) text = text.slice(a, b + 1);

    let out;
    try { out = JSON.parse(text); }
    catch (e) {
      console.error('adapt-method parse failure:', text.slice(0, 300));
      return res.status(502).json({ error: 'Could not rewrite the method. Please try again.' });
    }

    const newSteps = (Array.isArray(out.steps) ? out.steps : [])
      .filter(s => typeof s === 'string' && s.trim()).slice(0, 10);
    if (!newSteps.length) {
      return res.status(502).json({ error: 'Could not rewrite the method. Please try again.' });
    }

    return res.status(200).json({
      time: typeof out.time === 'string' ? out.time : '',
      equipment: (Array.isArray(out.equipment) ? out.equipment : [])
        .filter(e => e && typeof e.name === 'string' && e.name.trim())
        .slice(0, 8)
        .map(e => ({ emoji: typeof e.emoji === 'string' && e.emoji ? e.emoji : '🍴', name: e.name.trim() })),
      steps: newSteps,
      note: typeof out.note === 'string' ? out.note.trim().slice(0, 240) : ''
    });
  } catch (e) {
    console.error('adapt-method error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
