import { guard } from '../lib/guard.js';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();


  // Billed per call by Google. Same rule as the AI routes: signed-in users only.

  // This route is GET, so the token arrives as an Authorization header.

  const me = await guard(req, res, { bucket: 'places', max: 120 });

  if (!me) return;

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GOOGLE_KEY) {
    return res.status(500).json({ 
      status: 'NO_KEY',
      error: 'Google API key not configured in Vercel.' 
    });
  }

  const { type, lat, lng, keyword, address, latlng } = req.query;

  try {
    if (type === 'geocode') {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + GOOGLE_KEY;
      const response = await fetch(url);
      const data = await response.json();
      return res.status(200).json(data);
    }
    
    if (type === 'reverse') {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' + latlng + '&key=' + GOOGLE_KEY;
      const response = await fetch(url);
      const data = await response.json();
      return res.status(200).json(data);
    }
    
    if (type === 'nearby') {
      const isStore = keyword === 'grocery supermarket';
      const includedTypes = isStore ? ['grocery_store', 'supermarket'] : ['restaurant'];
      
      // Use the NEW Places API
      const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.location,places.googleMapsUri'
        },
        body: JSON.stringify({
          includedTypes: includedTypes,
          maxResultCount: 10,
          locationRestriction: {
            circle: {
              center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
              radius: 8000.0
            }
          }
        })
      });
      
      const responseText = await response.text();
      
      if (!response.ok) {
        return res.status(response.status).json({ 
          status: 'API_ERROR',
          error: responseText
        });
      }
      
      const data = JSON.parse(responseText);
      
      // Convert new API format to match old format for the frontend
      const results = (data.places || []).map(p => ({
        name: p.displayName?.text || 'Unknown',
        vicinity: p.formattedAddress || '',
        rating: p.rating,
        user_ratings_total: p.userRatingCount,
        price_level: p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE' ? 1 : 
                    p.priceLevel === 'PRICE_LEVEL_MODERATE' ? 2 :
                    p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' ? 3 :
                    p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE' ? 4 : null,
        opening_hours: p.currentOpeningHours ? { open_now: p.currentOpeningHours.openNow } : null,
        geometry: p.location ? { location: { lat: p.location.latitude, lng: p.location.longitude } } : null,
        url: p.googleMapsUri
      }));
      
      return res.status(200).json({ status: 'OK', results });
    }
    
    return res.status(400).json({ error: 'Invalid type parameter: ' + type });

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
