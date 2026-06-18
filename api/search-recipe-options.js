// /api/search-recipe-options.js — Cook tab text search, step 1.
// Given a dish (e.g. "orange cake"), returns several DIFFERENT recipe
// variations/methods (classic, chocolate-orange, cream-filled, flourless, etc.),
// each with metadata used by the filter/sort bar. The user picks one, and the
// app then calls /api/search-recipe with the chosen variation name to build the
// full recipe.
//
// Guard rails: rejects branded/restaurant-only items (e.g. "Big Mac") and non-food.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { query } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing search query' });

  const prompt = `A user searched a home-cooking app for: "${query}".

Most dishes have several DIFFERENT ways to make them that taste meaningfully different (different methods, ingredients, or flavor twists). For example "orange cake" could be: a classic orange cake, a chocolate-orange cake, an orange cream cake, a flourless almond-orange cake, an orange bundt with candied zest. Your job is to list these distinct variations so the user can pick one.

FIRST classify:
- If "${query}" is a real dish a home cook can make (including dishes also sold at restaurants, e.g. "orange chicken", "alfredo pasta") -> list the variations.
- If it is a BRANDED item tied to ONE specific chain (e.g. "Big Mac", "Baconator", "Crunchwrap Supreme") -> respond ONLY with: {"notHomemade": true}
- If it is not real food at all -> respond ONLY with: {"notFood": true}

When listing variations:
- Give 3-6 genuinely DIFFERENT versions. Each "variation" is a short distinguishing name (e.g. "Chocolate-Orange Cake", "Flourless Almond-Orange Cake"). Make them distinct in flavor or method, not trivial tweaks.
- For each, estimate realistic values: per-serving calories (number), total hands-on + cook time in minutes (number), per-serving grocery cost in USD (number), per-serving protein in grams (number).
- Set booleans accurately: vegetarian (true if no meat/fish), spicy (true if the dish is notably spicy/hot), dietFriendly (true if it's relatively light/lower-calorie for its category).
- Order with the most classic/popular variation first.

Respond ONLY with raw JSON, no markdown, no backticks, in exactly this shape:
{
  "dish": "Orange Cake",
  "options": [
    { "variation": "Classic Orange Cake", "blurb": "Moist butter cake with fresh orange juice and zest.", "calories": 340, "timeMinutes": 55, "price": 1.80, "proteinG": 5, "vegetarian": true, "spicy": false, "dietFriendly": false },
    { "variation": "Flourless Almond-Orange Cake", "blurb": "Naturally gluten-free, made with whole oranges and almonds.", "calories": 290, "timeMinutes": 90, "price": 2.40, "proteinG": 8, "vegetarian": true, "spicy": false, "dietFriendly": true }
  ]
}`;

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
        max_tokens: 1600,
        temperature: 0.3,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'AI error ' + response.status });
    }

    const data = JSON.parse(responseText);
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    let clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s !== -1 && e !== -1) clean = clean.substring(s, e + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Could not parse results.' });
    }

    if (parsed.notHomemade) return res.status(200).json({ notHomemade: true });
    if (parsed.notFood) return res.status(200).json({ notFood: true });

    const options = Array.isArray(parsed.options) ? parsed.options.filter(o => o && o.variation) : [];
    if (!options.length) return res.status(200).json({ notFood: true });

    return res.status(200).json({ dish: parsed.dish || query, options });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
