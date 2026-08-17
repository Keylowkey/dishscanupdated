// /api/copycat-recipe.js — Capture & Cook Healthier Homemade Copycat
// Takes a detected restaurant meal and returns a homemade recipe that tastes
// as close as possible to the original, but lighter in calories.

import { languageInstruction } from '../lib/i18n-data.js';
import { guard } from '../lib/guard.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {

  // Costs money per call — require a real signed-in account and cap the rate.
  const me = await guard(req, res, { bucket: 'copycat-recipe', max: 40 });
  if (!me) return;
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured.' });
  }

  const { restaurant, item, originalCalories, lang } = req.body || {};

  if (!item) {
    return res.status(400).json({ error: 'Missing meal information.' });
  }

  const calLine = (originalCalories !== null && originalCalories !== undefined)
    ? `The restaurant version has approximately ${originalCalories} calories per serving.`
    : `The restaurant version's calories are unknown; estimate them reasonably.`;

  const systemPrompt = `You are a chef for the "Capture & Cook" app who recreates restaurant dishes as healthier homemade recipes.

Goal: give the user a homemade recipe that tastes AS CLOSE AS POSSIBLE to the named restaurant dish, but with meaningfully fewer calories. Stay faithful to the original flavor, texture, and experience — this is a lighter copycat, not a totally different dish. Achieve the calorie savings through smart swaps (leaner proteins, less oil, lighter dairy, baking vs frying, smart portion of high-cal items) WITHOUT making it taste like diet food.

${calLine}

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no preamble, no backticks:
{
  "dish": "Homemade [item] (Lighter)",
  "inspiredBy": "${restaurant || 'Restaurant'} ${item}",
  "time": "30 min",
  "servings": 4,
  "difficulty": "Easy",
  "homemadeCalories": 420,
  "originalCalories": ${originalCalories ?? 'null'},
  "homemadeCostPerServing": 3.25,
  "takeoutPrice": 9.99,
  "tasteNote": "One sentence on how this keeps the original flavor (e.g. what makes it taste like the real thing).",
  "lighterBecause": ["Short bullet on a key swap", "Another swap", "Another swap"],
  "equipment": [
    { "emoji": "🍳", "name": "Large skillet" },
    { "emoji": "🔪", "name": "Chef's knife" }
  ],
  "ingredients": [
    { "emoji": "🍗", "name": "Chicken breast", "qty": "1 lb" }
  ],
  "steps": [
    "Step one instruction.",
    "Step two instruction."
  ]
}

Rules:
- homemadeCalories MUST be a realistic per-serving number that is clearly lower than the original.
- homemadeCostPerServing: realistic per-serving grocery cost (USD) to make this at home, US national average.
- takeoutPrice: the typical menu price (USD) a customer pays for ONE serving of the original restaurant item. Estimate from your knowledge of that chain's pricing.
- equipment: 3-6 cooking appliances/tools genuinely needed, each with an appropriate emoji.
- Keep ingredients realistic and accessible; include an emoji for each.
- 6–12 ingredients, 4–8 steps is ideal.
- lighterBecause: 2–4 concise swaps that explain the calorie savings.
- Keep it genuinely tasty and faithful to the original — prioritize flavor closeness.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Create a healthier homemade copycat recipe for: ${restaurant ? restaurant + ' ' : ''}${item}. Make it taste as close to the original as possible, just lighter. Return JSON only.` + languageInstruction(lang),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return res.status(response.status).json({ error: 'Anthropic API Error ' + response.status + ': ' + errText.substring(0, 300) });
    }

    const data = await response.json();
    const rawText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn('Could not parse copycat output:', cleaned);
      return res.status(502).json({ error: 'Could not generate a recipe. Please try again.' });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error('copycat-recipe error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
