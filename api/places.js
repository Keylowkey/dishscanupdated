export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GOOGLE_KEY) {
    return res.status(500).json({ error: 'Google API key not configured. Add GOOGLE_PLACES_API_KEY to Vercel environment variables.' });
  }

  const { type, lat, lng, keyword, address, latlng } = req.query;

  try {
    let url;

    if (type === 'geocode') {
      url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
    } else if (type === 'reverse') {
      url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latlng}&key=${GOOGLE_KEY}`;
    } else if (type === 'nearby') {
      const placeType = keyword === 'grocery supermarket' ? 'grocery_or_supermarket' : 'restaurant';
      url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=8000&keyword=${encodeURIComponent(keyword)}&type=${placeType}&key=${GOOGLE_KEY}`;
    } else {
      return res.status(400).json({ error: 'Invalid type parameter' });
    }

    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
