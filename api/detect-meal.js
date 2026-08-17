
import { guard } from '../lib/guard.js';// /api/detect-meal.js — Capture & Cook Takeout Nutrition Detector
// Identifies restaurant + menu item from packaging/meal photo and returns
// the published nutrition panel. Returns { detectable: false } if it can't
// confidently identify the meal.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {

  // Costs money per call — require a real signed-in account and cap the rate.
  const me = await guard(req, res, { bucket: 'detect-meal', max: 60 });
  if (!me) return;
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured.' });
  }

  const { image_data, media_type } = req.body || {};

  if (!image_data || !media_type) {
    return res.status(400).json({ error: 'Missing image data.' });
  }

  const systemPrompt = `You are a precise restaurant-meal nutrition identifier for the "Capture & Cook" app.

The user photographs takeout/restaurant food, often including packaging (bags, cups, wrappers, containers, tray liners, branding, logos, receipts). Your job:

1. Identify the RESTAURANT/CHAIN from any visible branding, packaging design, logos, cup/wrapper patterns, or distinctive presentation.
2. Identify the specific MENU ITEM that was ordered.
3. Provide the restaurant's PUBLISHED nutrition for that item (the standard/default size unless the image clearly indicates otherwise).

CONFIDENCE RULES — be honest, never fabricate:
- Only return a detected meal if you can identify BOTH the restaurant/source AND a specific menu item with reasonable confidence.
- If you can see it's restaurant food but cannot confidently determine the chain OR the specific item, you MUST return undetectable.
- Generic home-cooked food with no packaging/branding cues → undetectable (that belongs in the app's other tab).
- Do not guess a restaurant from food appearance alone without packaging/branding evidence.
- Use the restaurant's officially published nutrition values for the identified item. If only partial nutrition is known for that item, fill what you know and use null for unknown fields.

RESPONSE FORMAT — return ONLY valid JSON, no markdown, no preamble, no backticks.

If detectable:
{
  "detectable": true,
  "restaurant": "Chipotle",
  "item": "Chicken Burrito Bowl",
  "size": "Standard",
  "confidence": "high" | "medium",
  "detectedFrom": "Short note on what gave it away (e.g. 'Chipotle bowl + logo on bag')",
  "calories": 630,
  "nutrition": {
    "protein_g": 45,
    "carbs_g": 40,
    "fat_g": 23,
    "saturated_fat_g": 7,
    "sodium_mg": 1250,
    "sugar_g": 4,
    "fiber_g": 9,
    "cholesterol_mg": 125
  },
  "servingNote": "Values are per standard serving as published by the restaurant.",
  "note": "Optional short caveat, e.g. 'Add-ons like guac not included.'"
}

If NOT detectable:
{
  "detectable": false
}

Any nutrition value you genuinely don't know → use null (not 0). calories should be a number when detectable; if you truly cannot estimate calories for an identified item, still return detectable:true with calories:null and explain in "note".`;

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: media_type,
                  data: image_data,
                },
              },
              {
                type: 'text',
                text: 'Identify this restaurant meal from the packaging and food, and return its published nutrition as JSON. If you cannot confidently identify both the restaurant and the specific item, return {"detectable": false}.',
              },
            ],
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

    // Pull the text out of the content blocks
    const rawText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    // Strip any accidental code fences, then parse
    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // If the model didn't return clean JSON, treat as undetectable rather than erroring
      console.warn('Could not parse model output:', cleaned);
      return res.status(200).json({ detectable: false });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error('detect-meal error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
