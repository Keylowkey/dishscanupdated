// /api/import-recipe.js
// Turn a shared social link into a full recipe (same JSON shape as /api/analyze).
//  - YouTube: title + full description (rich text) -> recipe.
//  - Instagram / TikTok: caption is blocked/short, so the cover thumbnail image
//    is run through vision -> recipe.
// Returns the identical recipe object the app already renders.

import { languageInstruction } from '../lib/i18n-data.js';
import { guard } from '../lib/guard.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const RECIPE_JSON = `{"dish":"Specific Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian or Contains meat etc","calories":420,"nutrition":{"protein_g":28,"carbs_g":45,"fat_g":14,"saturated_fat_g":4,"fiber_g":6,"sugar_g":8,"sodium_mg":620,"cholesterol_mg":75},"equipment":[{"emoji":"🍳","name":"Large skillet"},{"emoji":"🔪","name":"Chef's knife"}],"ingredients":[{"emoji":"appropriate food emoji","name":"Ingredient name","qty":"1 cup","cost":2.50}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword","totalCost":15.50,"costNote":"Based on US national average grocery prices"}`;

const RULES = `Rules:
- 6-8 ingredients with accurate emojis AND realistic cost estimates (USD)
- 3-6 pieces of equipment with appropriate emojis
- 4-6 detailed cooking steps
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- nutrition: realistic PER-SERVING numeric values for all eight fields
- 1-3 word searchKeyword
- totalCost should equal the sum of all ingredient costs
Respond ONLY with a raw JSON object — no markdown, no backticks, no text outside the JSON.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Costs money per call — require a real signed-in account and cap the rate.
  const me = await guard(req, res, { bucket: 'import-recipe', max: 30 });
  if (!me) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'AI is not configured on the server.' });

  try {
    let { url, lang } = req.body || {};
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: 'Please share a valid link.' });
    }
    url = url.trim();
    const platform = detectPlatform(url);

    let content;
    let sourceTitle = '';

    if (platform === 'youtube') {
      const info = await youtubeInfo(url);
      if (!info.title && !info.description) {
        return res.status(422).json({ error: "Couldn't read that YouTube video." });
      }
      sourceTitle = info.title || '';
      content = [{ type: 'text', text: textPrompt(info.title, info.description) }];
    } else {
      // Instagram / TikTok / other → thumbnail image
      const thumb = await ogImage(url);
      if (!thumb || !isRealThumb(thumb, platform)) {
        return res.status(422).json({ error: platform === 'instagram'
          ? "Instagram didn't share the dish this time (they block servers from reading reels). Screenshot the reel and use “Choose Photo” instead."
          : "Couldn't read that link. Try sharing a screenshot of the dish instead." });
      }
      const img = await fetchImageAsBase64(thumb);
      if (!img) return res.status(422).json({ error: "Couldn't load the video's thumbnail." });
      content = [
        { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
        { type: 'text', text: imagePrompt() }
      ];
    }

    // Ask for the recipe in the user's language.
    const li = languageInstruction(lang);
    if (li) content.push({ type: 'text', text: li });
    const recipe = await callAnthropic(ANTHROPIC_KEY, content);
    if (recipe && recipe.error) return res.status(502).json(recipe);
    // Guard: if the AI ended up describing a logo / brand image / screenshot chrome
    // rather than a dish, don't return a junk recipe.
    if (recipe && /\b(logo|instagram|tiktok|youtube|screenshot|watermark|app icon|profile (picture|photo)|placeholder)\b/i.test(String(recipe.dish || ''))) {
      return res.status(422).json({ error: "Couldn't read a dish from that link. Try sharing a screenshot of the dish instead." });
    }
    if (sourceTitle && recipe) recipe.sourceTitle = sourceTitle;
    return res.status(200).json(recipe);
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err && err.message || err) });
  }
}

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return 'other';
}

// True only if the thumbnail looks like real post CONTENT (not a brand logo /
// static asset served on a login/blocked page).
function isRealThumb(u, platform) {
  if (!/^https?:\/\//i.test(u || '')) return false;
  if (/\/static\/|logo|sprite|favicon|\bicon\b|placeholder/i.test(u)) return false;
  if (platform === 'instagram') return /cdninstagram\.com|fbcdn\.net|scontent/i.test(u);
  if (platform === 'tiktok') return /tiktokcdn|ibyteimg|muscdn|p\d+-sign/i.test(u);
  return true;
}

async function youtubeInfo(url) {
  let title = '', description = '';
  try {
    const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (o.ok) { const j = await o.json(); title = j.title || ''; }
  } catch (e) { /* ignore */ }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (r.ok) {
      const html = await r.text();
      if (!title) title = extractOg(html, 'title');
      const m = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
      if (m) {
        description = m[1]
          .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\"/g, '"')
          .replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      }
      if (!description) description = extractOg(html, 'description');
    }
  } catch (e) { /* ignore */ }
  if (description.length > 3000) description = description.slice(0, 3000);
  return { title, description };
}

async function ogImage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) return '';
    return extractOg(await r.text(), 'image');
  } catch (e) { return ''; }
}

async function fetchImageAsBase64(imgUrl) {
  try {
    const r = await fetch(imgUrl, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const media_type = /^image\/(png|jpe?g|webp|gif)$/i.test(ct) ? ct.replace('jpg', 'jpeg') : 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
    return { media_type, data: buf.toString('base64') };
  } catch (e) { return null; }
}

function extractOg(html, prop) {
  const res = [
    new RegExp('<meta[^>]+property=["\']og:' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*property=["\']og:' + prop + '["\']', 'i')
  ];
  for (const re of res) { const m = html.match(re); if (m) return decodeHtml(m[1]); }
  return '';
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function textPrompt(title, description) {
  return `You are an expert chef, nutritionist, and grocery cost estimator. A user shared a cooking video. From its title and description, produce the COMPLETE recipe for the dish. If the description already lists ingredients/steps, follow them faithfully; otherwise reconstruct an authentic recipe for the named dish. Ignore promotional links, hashtags, and channel boilerplate.

VIDEO TITLE: ${title}
VIDEO DESCRIPTION: ${description || '(none provided)'}

Estimate each ingredient's cost in USD (US national average) and realistic per-serving nutrition. Respond ONLY with a raw JSON object in EXACTLY this structure:
${RECIPE_JSON}

${RULES}`;
}

function imagePrompt() {
  return `You are an expert chef, nutritionist, and grocery cost estimator. This image is the cover/thumbnail frame of a cooking video. Identify the EXACT dish shown and produce its complete recipe. Be SPECIFIC with the dish name (e.g. "Chicken Biryani" not "Rice with Chicken").

Estimate each ingredient's cost in USD (US national average) and realistic per-serving nutrition. Respond ONLY with a raw JSON object in EXACTLY this structure:
${RECIPE_JSON}

${RULES}`;
}

async function callAnthropic(key, content) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2500, temperature: 0.2, messages: [{ role: 'user', content }] })
  });
  const responseText = await response.text();
  if (!response.ok) return { error: 'AI error ' + response.status + ': ' + responseText.slice(0, 300) };
  let text = '';
  try {
    const data = JSON.parse(responseText);
    text = (data.content || []).find((b) => b.type === 'text')?.text || '';
  } catch (e) { return { error: 'Unexpected AI response.' }; }
  let clean = text.replace(/```json|```/g, '').trim();
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a !== -1 && b !== -1) clean = clean.slice(a, b + 1);
  try { return JSON.parse(clean); } catch (e) { return { error: 'Could not parse the recipe. Please try again.' }; }
}
