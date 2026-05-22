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

    const prompt = `You are an expert chef and nutritionist with access to Google Search.

TASK: Identify the EXACT dish in this image. Look carefully at:
- The cooking method (fried, baked, grilled)
- The ingredients visible (meat type, cheese, sauces)
- The shape and presentation
- Cultural cuisine indicators

Common dishes that look similar that you should distinguish between:
- Birria Quesadilla (Mexican, beef + cheese in fried tortilla, often consommé)
- Philly Cheesesteak (American sandwich, beef + cheese + onions in hoagie roll)
- Empanadas (folded pastry)
- Phyllo pockets (layered flaky pastry)
- Quesabirria (similar to birria quesadilla)

After identifying, use Google Search to verify your identification matches typical visual presentations.

Respond ONLY with a raw JSON object - no markdown, no backticks, no explanation. Keep all strings concise. Use exactly this structure:

{"dish":"Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Contains meat","calories":420,"ingredients":[{"emoji":"🥩","name":"Beef","qty":"1 lb"}],"steps":["Step one.","Step two."],"swaps":[{"from":"X","to":"Y","saving":60}],"searchKeyword":"keyword"}

Rules:
- Be SPECIFIC with dish name
- Exactly 6 ingredients (keep names short)
- Exactly 4 short cooking steps
- Exactly 3 swaps
- Accurate calories per serving
- 1-2 word searchKeyword
- BE CONSISTENT: same dish always gets same name`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

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
          maxOutputTokens: 8000
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
        error: 'Could not parse recipe. Raw response: ' + text.substring(0, 800)
      });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
