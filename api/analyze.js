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
    const { image_data, media_type } = req.body;
    if (!image_data || !media_type) {
      return res.status(400).json({ error: 'Missing image_data or media_type' });
    }

    const prompt = `You are an expert chef and nutritionist. Carefully examine this food image and identify the EXACT dish shown.

Look at:
- The cooking method (fried, baked, grilled, steamed)
- The ingredients visible (meat type, cheese, sauces, vegetables)
- The shape and presentation
- Cultural cuisine indicators (spices, garnishes, plating style)

Be SPECIFIC with the dish name (e.g., "Beef Birria Quesadilla" not just "Quesadilla", "Chicken Biryani" not just "Rice with Chicken", "Manakish Za'atar" not just "Flatbread").

For international dishes, use the authentic name (e.g., "Mansaf", "Pad Thai", "Pho", "Tagine", "Pierogi").

Respond ONLY with a raw JSON object - no markdown, no backticks, no explanation outside the JSON. Use exactly this structure:

{"dish":"Specific Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian or Contains meat etc","calories":420,"ingredients":[{"emoji":"appropriate food emoji","name":"Ingredient name","qty":"1 cup"}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword"}

Rules:
- 6-8 ingredients with accurate emojis
- 4-6 detailed cooking steps
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- 1-3 word searchKeyword for finding this dish at restaurants
- BE CONSISTENT: For the same dish, always return the same name`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_data } },
            { type: 'text', text: prompt }
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
