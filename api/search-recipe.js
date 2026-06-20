// /api/search-recipe.js — text search for HOME-COOKED recipes (Cook tab).
// Takes a dish name and returns a full recipe in the same shape as analyze.js.
// Refuses branded/restaurant-specific items (e.g. "Big Mac") so the Cook tab
// stays for general home cooking — those belong on the Takeout tab.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Server not configured' });

  const { query, variation } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing search query' });

  const variationLine = variation && variation.trim()
    ? `\n\nThe user specifically wants this variation: "${variation}". Make THIS version of the dish, and use it as the dish name.`
    : '';

  const prompt = `You are an expert chef, nutritionist, and grocery cost estimator. A user searched for a recipe by name: "${query}".${variationLine}

FIRST, decide whether this is a GENERAL dish that a home cook makes (e.g. "Orange Cake", "Kabsa", "Alfredo Pasta", "Cajun Chicken", "Butter Chicken", "Tacos", "Lasagna") OR a BRANDED/RESTAURANT-SPECIFIC menu item tied to a particular chain (e.g. "Big Mac", "Baconator", "Crunchwrap Supreme", "Loaded Potato Beef Griller", "Whopper", "McNuggets").

- If it is a BRANDED or restaurant-specific item, respond ONLY with: {"notHomemade": true}
- If the text is not a real food/dish at all (gibberish, random words), respond ONLY with: {"notFood": true}
- Otherwise, create the best authentic HOME recipe for it.

When creating the recipe, be specific and authentic. For international dishes use the authentic name and traditional preparation. Estimate realistic US national-average grocery costs for only the quantity needed.

Respond ONLY with a raw JSON object - no markdown, no backticks, no explanation outside the JSON. Use exactly this structure:

{"dish":"Specific Full Dish Name","servings":4,"time":"45 min","difficulty":"Medium","dietary":"Vegetarian or Contains meat etc","calories":420,"nutrition":{"protein_g":28,"carbs_g":45,"fat_g":14,"saturated_fat_g":4,"fiber_g":6,"sugar_g":8,"sodium_mg":620,"cholesterol_mg":75},"equipment":[{"emoji":"🍳","name":"Large skillet"},{"emoji":"🔪","name":"Chef's knife"}],"ingredients":[{"emoji":"🥚","name":"Ingredient name","qty":"1 cup","cost":2.50}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword","totalCost":15.50,"costNote":"Based on US national average grocery prices"}

Rules:
- 6-8 ingredients with accurate emojis AND realistic cost estimates (USD)
- 3-6 pieces of equipment with appropriate emojis
- 4-6 detailed cooking steps
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- nutrition: realistic PER-SERVING values as numbers (grams for macros, mg for sodium/cholesterol) for all eight fields, estimated from the ingredients. These are estimates.
- totalCost should equal the sum of all ingredient costs
- BE CONSISTENT: for the same dish, always return the same name and similar costs`;

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
        max_tokens: 2500,
        temperature: 0.1,
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

    try {
      const recipe = JSON.parse(clean);
      return res.status(200).json(recipe);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Could not parse recipe.' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
