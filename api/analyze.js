import { languageInstruction } from '../lib/i18n-data.js';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  try {
    const { image_data, media_type, lang } = req.body;
    if (!image_data || !media_type) {
      return res.status(400).json({ error: 'Missing image_data or media_type' });
    }

    const prompt = `You are an expert chef, nutritionist, and grocery cost estimator. Carefully examine this food image and identify the EXACT dish shown.

Look at:
- The cooking method (fried, baked, grilled, steamed)
- The ingredients visible (meat type, cheese, sauces, vegetables)
- The shape and presentation
- Cultural cuisine indicators (spices, garnishes, plating style)

Be SPECIFIC with the dish name (e.g., "Beef Birria Quesadilla" not just "Quesadilla", "Chicken Biryani" not just "Rice with Chicken").

For international dishes, use the authentic name (e.g., "Mansaf", "Pad Thai", "Pho", "Tagine", "Pierogi", "Kabsa", "Manakish").

For each ingredient, estimate the approximate cost in USD to buy ONLY the quantity needed for this recipe at a typical US grocery store (national average). Be realistic — small quantities of spices might be $0.20-$0.50, while a pound of meat might be $4-$10.

For equipment, list the cooking appliances, tools, and cookware actually needed to make this dish (e.g., "Large skillet", "Blender", "Oven", "Mixing bowl", "Chef's knife", "Tongs"). Include an appropriate emoji for each. List only what's genuinely required — typically 3-6 items.

Respond ONLY with a raw JSON object - no markdown, no backticks, no explanation outside the JSON. Use exactly this structure:

{"dish":"Specific Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian or Contains meat etc","calories":420,"nutrition":{"protein_g":28,"carbs_g":45,"fat_g":14,"saturated_fat_g":4,"fiber_g":6,"sugar_g":8,"sodium_mg":620,"cholesterol_mg":75},"equipment":[{"emoji":"🍳","name":"Large skillet"},{"emoji":"🔪","name":"Chef's knife"}],"ingredients":[{"emoji":"appropriate food emoji","name":"Ingredient name","qty":"1 cup","cost":2.50}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword","totalCost":15.50,"costNote":"Based on US national average grocery prices"}

Rules:
- 6-8 ingredients with accurate emojis AND realistic cost estimates (USD)
- 3-6 pieces of equipment with appropriate emojis
- 4-6 detailed cooking steps
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- nutrition: realistic PER-SERVING values as numbers (grams for macros, mg for sodium/cholesterol). Estimate all eight fields from the ingredients. These are estimates.
- 1-3 word searchKeyword for finding this dish at restaurants
- totalCost should equal the sum of all ingredient costs
- BE CONSISTENT: For the same dish, always return the same name and similar costs`;

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
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_data } },
            { type: 'text', text: prompt + languageInstruction(lang) }
          ]
        }]
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: 'Anthropic API Error ' + response.status + ': ' + responseText.substring(0, 500)
      });
    }

    const data = JSON.parse(responseText);
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    
    let clean = text.replace(/```json|```/g, '').trim();
    
    const jsonStart = clean.indexOf('{');
    const jsonEnd = clean.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      clean = clean.substring(jsonStart, jsonEnd + 1);
    }

    try {
      const recipe = JSON.parse(clean);
      return res.status(200).json(recipe);
    } catch (parseErr) {
      return res.status(500).json({ 
        error: 'Could not parse recipe. Raw response: ' + text.substring(0, 500)
      });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
