export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured.' });
  }

  try {
    const { image_data, media_type } = req.body;
    if (!image_data || !media_type) {
      return res.status(400).json({ error: 'Missing image_data or media_type' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type, data: image_data }
            },
            {
              type: 'text',
              text: 'You are a professional chef and nutritionist. Analyze this food image and respond ONLY with a raw JSON object - no markdown, no backticks, no explanation. Use exactly this structure: {"dish":"Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian","calories":420,"ingredients":[{"emoji":"food emoji","name":"Ingredient name","qty":"1 cup"}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword"} Provide 6-8 ingredients with accurate emojis, 4-6 detailed cooking steps, 3 calorie-reducing swaps that preserve flavor, accurate per-serving calorie estimate, and a 1-3 word searchKeyword.'
            }
          ]
        }]
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: 'API Error ' + response.status + ': ' + responseText
      });
    }

    const data = JSON.parse(responseText);
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();

    try {
      const recipe = JSON.parse(clean);
      return res.status(200).json(recipe);
    } catch {
      return res.status(500).json({ error: 'Could not parse recipe. Raw: ' + clean.substring(0, 300) });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
