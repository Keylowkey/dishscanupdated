export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured. Add GEMINI_API_KEY to Vercel environment variables.' });
  }

  try {
    const { image_data, media_type } = req.body;
    if (!image_data || !media_type) {
      return res.status(400).json({ error: 'Missing image_data or media_type' });
    }

    const prompt = `You are an expert chef and nutritionist with access to web search. Carefully examine this food image.

STEP 1: Use Google Search to verify what dish this is. Search for visual descriptions of the dish to confirm your identification.

STEP 2: Once confirmed, respond ONLY with a raw JSON object - no markdown, no backticks, no explanation outside the JSON. Use exactly this structure:

{"dish":"Specific Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian or Contains meat etc","calories":420,"ingredients":[{"emoji":"appropriate food emoji","name":"Ingredient name","qty":"1 cup"}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword"}

Rules:
- Be VERY specific with the dish name (e.g., "Beef Birria Quesadilla" not just "Quesadilla")
- 6-8 ingredients with accurate emojis
- 4-6 detailed cooking steps
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- 1-3 word searchKeyword for finding this dish at restaurants
- BE CONSISTENT: For the same dish, always return the same name`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_KEY}`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: media_type, data: image_data } },
            { text: prompt }
          ]
        }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2000
        }
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: 'Gemini API Error ' + response.status + ': ' + responseText.substring(0, 500)
      });
    }

    const data = JSON.parse(responseText);
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
    
    // Extract JSON from response (Gemini sometimes wraps in markdown despite instructions)
    let clean = text.replace(/```json|```/g, '').trim();
    
    // Find the JSON object if there's text around it
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
