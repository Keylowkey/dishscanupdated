// /api/verify-food.js — gate: only food photos may be shared to the feed
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const { image_data, media_type } = req.body || {};
  if (!image_data || !media_type) return res.status(400).json({ error: 'Missing image.' });

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
        max_tokens: 200,
        temperature: 0,
        system: `You are a strict content gate for a food-sharing app. Decide if the image is primarily a photo of FOOD or DRINK (a dish, meal, ingredients, baked goods, beverages). People may appear incidentally (e.g. a hand holding a plate) but food must be the clear subject.

NOT acceptable: selfies/portraits, people as the subject, pets/animals, screenshots, memes, text images, scenery, objects, or anything sexual, violent, or otherwise unrelated to food.

Respond ONLY with raw JSON: {"isFood": true} or {"isFood": false, "reason": "short friendly reason"}`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_data } },
            { type: 'text', text: 'Is this a food photo? JSON only.' }
          ]
        }]
      })
    });

    if (!response.ok) {
      const t = await response.text();
      return res.status(response.status).json({ error: 'Verification error: ' + t.substring(0, 200) });
    }
    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { parsed = { isFood: false, reason: 'Could not verify the image. Please try another photo.' }; }
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
