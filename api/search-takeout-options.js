// /api/search-takeout-options.js — for the Takeout tab text search.
// Given a dish search (e.g. "orange chicken"), returns a list of restaurant
// chains known for that item, each with estimated calories and typical price,
// plus a generic "Classic takeout-style" option. The user picks one, and the
// app then calls /api/copycat-recipe to build that chain's lighter recipe.
//
// Guard rails: rejects general home-only dishes (e.g. "Kabsa") and non-food.
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

  const prompt = `A user searched the "Takeout" tab of a food app for: "${query}".

This tab is for restaurant and fast-food items. Your job is to list the restaurants/chains that are well known for this item, so the user can pick which version they want a copycat recipe for.

FIRST classify:
- If "${query}" is a real food item that restaurants/fast-food chains commonly serve (including dishes that are ALSO made at home but are very commonly ordered out — e.g. "orange chicken", "fettuccine alfredo", "pad thai", "buffalo wings", "california roll") -> list the options.
- If it is a specific branded item already tied to ONE chain (e.g. "Big Mac", "Baconator", "Crunchwrap Supreme") -> return just that one chain plus the generic option.
- If it is a strictly home-only dish that restaurants/chains do NOT typically sell (e.g. "Kabsa", "Mansaf", "homemade meatloaf") -> respond ONLY with: {"notRestaurant": true}
- If it is not a real food at all -> respond ONLY with: {"notFood": true}

When listing options:
- Include 2-5 REAL, well-known chains/restaurants actually known for this item. Use real chain names (e.g. Panda Express, P.F. Chang's, Pei Wei for orange chicken).
- ALWAYS also include one generic option with restaurant set to "Classic takeout-style" representing a typical version not tied to a specific chain.
- For each, estimate: the real item's calories per serving (number), typical menu price in USD (number), per-serving protein in grams (number), and total time in minutes to make a homemade copycat (number).
- Set booleans accurately: vegetarian (true if no meat/fish), spicy (true if notably spicy), dietFriendly (true if relatively light/lower-calorie for its category).
- Order the list with the most iconic/popular chain for this item first; put the generic option last.

Respond ONLY with raw JSON, no markdown, no backticks, in exactly this shape:
{
  "dish": "Orange Chicken",
  "options": [
    { "restaurant": "Panda Express", "item": "Orange Chicken", "calories": 490, "price": 8.50, "proteinG": 24, "timeMinutes": 40, "vegetarian": false, "spicy": false, "dietFriendly": false },
    { "restaurant": "P.F. Chang's", "item": "Orange Chicken", "calories": 820, "price": 16.00, "proteinG": 30, "timeMinutes": 45, "vegetarian": false, "spicy": false, "dietFriendly": false },
    { "restaurant": "Classic takeout-style", "item": "Orange Chicken", "calories": 600, "price": 11.00, "proteinG": 26, "timeMinutes": 40, "vegetarian": false, "spicy": false, "dietFriendly": false }
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
        max_tokens: 1200,
        temperature: 0.2,
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

    if (parsed.notRestaurant) return res.status(200).json({ notRestaurant: true });
    if (parsed.notFood) return res.status(200).json({ notFood: true });

    // Normalize
    const options = Array.isArray(parsed.options) ? parsed.options.filter(o => o && o.restaurant && o.item) : [];
    if (!options.length) return res.status(200).json({ notRestaurant: true });

    return res.status(200).json({ dish: parsed.dish || query, options });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
