// /api/import-recipe.js
// Turn a shared link into a full recipe (same JSON shape as /api/analyze).
//
// POST { url, post?, caption?, captionImages?, lang? }
//   post          what the app read from the page on the phone (lib/social-post.js)
//   caption       recipe text the user pasted themselves; overrides everything
//   captionImages [{ data, media_type }], up to 3: screenshots of the caption,
//                 read by the AI. For posts nothing else can read: Instagram's
//                 app doesn't let people copy a caption, but they can screenshot it.
//
// The recipe in a food video is usually written in its caption, so the
// caption decides:
//   1. caption has a recipe      → that recipe, followed faithfully. The cover
//                                  is not even shown to the AI.
//   2. caption names the dish    → an authentic recipe for that dish
//   3. caption says nothing, or
//      could not be read         → the dish in the cover image (a guess)
// recipe.source = { platform, author, basis, captionRead } says which, so
// the app can tell the user and offer to paste the caption when it's a guess.

import { languageInstruction } from '../lib/i18n-data.js';
import { guard } from '../lib/guard.js';
import { store as storeDishImage } from '../lib/dish-images.js';
import { readPost, cleanCaption, captionHasWords } from '../lib/social-post.js';
import crypto from 'node:crypto';
import { MAKEABLE_EXAMPLE, COOKING_EQUIPMENT_EXAMPLE, EXTRA_RULES, normalizeRecipeExtras } from '../lib/recipe-extras.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const PLATFORM_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', other: 'web' };

const RECIPE_JSON = `{"basis":"caption_recipe","dish":"Specific Full Dish Name","servings":2,"time":"30 min","difficulty":"Easy","dietary":"Vegetarian or Contains meat etc","calories":420,"nutrition":{"protein_g":28,"carbs_g":45,"fat_g":14,"saturated_fat_g":4,"fiber_g":6,"sugar_g":8,"sodium_mg":620,"cholesterol_mg":75},"equipment":[{"emoji":"🍳","name":"Large skillet"},{"emoji":"🔪","name":"Chef's knife"}],${COOKING_EQUIPMENT_EXAMPLE},"ingredients":[{"emoji":"appropriate food emoji","name":"Ingredient name","qty":"1 cup","cost":2.50,${MAKEABLE_EXAMPLE}}],"steps":["Detailed step one.","Detailed step two."],"swaps":[{"from":"Original ingredient","to":"Healthier alternative","saving":60}],"searchKeyword":"short keyword","totalCost":15.50,"costNote":"Based on US national average grocery prices"}`;

// `followText`: the post's own recipe is being followed, so counts come from it.
function rules(followText) {
  return `Rules:
- ingredients: ${followText ? 'every ingredient the post lists, however many, in its order; 6-8 only if you are writing the recipe yourself' : '6-8'}, each with an accurate emoji AND a realistic cost estimate (USD)
- 3-6 pieces of equipment with appropriate emojis
- steps: ${followText ? 'as many as the method needs (3-8)' : '4-6'}, detailed
- 3 calorie-reducing swaps that preserve flavor
- Accurate per-serving calorie estimate
- nutrition: realistic PER-SERVING numeric values for all eight fields
- 1-3 word searchKeyword
- totalCost should equal the sum of all ingredient costs${EXTRA_RULES}
Respond ONLY with a raw JSON object — no markdown, no backticks, no text outside the JSON.`;
}

// Screenshots of the caption, as sent by the app (already resized there).
function captionScreenshots(list) {
  return (Array.isArray(list) ? list : []).slice(0, 3).map(img => {
    if (!img || typeof img !== 'object' || typeof img.data !== 'string') return null;
    const media_type = /^image\/(png|jpeg|webp)$/.test(img.media_type) ? img.media_type : 'image/jpeg';
    if (img.data.length < 2000 || img.data.length > 1400000 || /[^A-Za-z0-9+/=]/.test(img.data.slice(0, 200))) return null;
    return { media_type, data: img.data };
  }).filter(Boolean);
}

// A caption that carries amounts is a recipe, not a description.
function looksLikeRecipe(text) {
  const t = String(text || '');
  const amounts = (t.match(/(\d|½|¼|¾)\s*(g|kg|oz|lbs?|ml|l|cups?|tbsp|tbs|tsp|tablespoons?|teaspoons?|cloves?|sheets?|slices?|cans?|pinch|handful)\b/gi) || []).length;
  return amounts >= 3 || (amounts >= 1 && /\b(ingredients|instructions|method|directions|recipe)\b/i.test(t));
}

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
    const body = req.body || {};
    let { url, lang } = body;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({ error: 'Please share a valid link.' });
    }
    url = url.trim();

    const pasted = cleanCaption(typeof body.caption === 'string' ? body.caption : '');
    const shots = !pasted ? captionScreenshots(body.captionImages) : [];
    const shot = shots.length > 0;
    const post = await readPost(url, body.post);
    const platform = post.platform;
    const caption = pasted || (shot ? '' : post.caption);
    // YouTube and web pages also have a title worth reading on its own.
    const title = (platform === 'youtube' || platform === 'other' || platform === 'facebook') ? post.title : '';
    const hasText = shot || captionHasWords(caption) || captionHasWords(title);
    const followText = shot || looksLikeRecipe(caption);

    // The cover is the dish's picture either way; the AI only sees it when
    // the words alone don't settle what the dish is.
    const cover = post.coverUrl ? await fetchImageAsBase64(post.coverUrl) : null;
    const showImage = !!cover && !followText;   // never alongside a caption screenshot

    if (!hasText && !cover) {
      return res.status(422).json({
        code: 'unreadable', platform,
        error: platform === 'instagram' || platform === 'tiktok'
          ? `${PLATFORM_NAMES[platform]} didn't let us read that post. Paste its caption, or share a screenshot of the dish.`
          : "Couldn't read that link. Paste the recipe text, or share a screenshot of the dish."
      });
    }

    const content = [];
    if (shot) shots.forEach(i => content.push({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
    else if (showImage) content.push({ type: 'image', source: { type: 'base64', media_type: cover.media_type, data: cover.data } });
    content.push({ type: 'text', text: hasText
      ? postPrompt({ platform, author: post.author, title, caption, hasImage: showImage, followText, pasted: !!pasted, screenshot: shot })
      : imagePrompt() });

    // Ask for the recipe in the user's language.
    const li = languageInstruction(lang);
    if (li) content.push({ type: 'text', text: li });
    const recipe = await callAnthropic(ANTHROPIC_KEY, content);
    if (recipe && recipe.error) return res.status(502).json(recipe);
    if (!recipe || recipe.notRecipe || !recipe.dish) {
      return res.status(422).json({ code: 'not_recipe', platform, error: "That post doesn't seem to be about a dish. Try another link, or share a screenshot of the food." });
    }

    let basis = ['caption_recipe', 'caption_dish', 'image'].includes(recipe.basis) ? recipe.basis : (hasText ? 'caption_dish' : 'image');
    if (!hasText) basis = 'image';
    if (!showImage && basis === 'image') basis = 'caption_dish';
    delete recipe.basis;

    // Guard: if the AI ended up describing a logo / brand image / screenshot chrome
    // rather than a dish, don't return a junk recipe.
    if (basis === 'image' && /\b(logo|instagram|tiktok|youtube|screenshot|watermark|app icon|profile (picture|photo)|placeholder)\b/i.test(String(recipe.dish || ''))) {
      return res.status(422).json({ code: 'unreadable', platform, error: "Couldn't read a dish from that link. Paste its caption, or share a screenshot of the dish." });
    }

    recipe.source = { platform, author: post.author || '', basis, captionRead: !!pasted || shot || post.read, pasted: !!pasted || shot };
    recipe.sourceUrl = url;
    if (post.title) recipe.sourceTitle = post.title;
    // Keep the cover as the dish image. Instagram and TikTok image URLs expire
    // within days, so it's copied into our own storage. Best-effort: without
    // it the app falls back to a generated image.
    if (cover && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const ext = /png/.test(cover.media_type) ? 'png' : /webp/.test(cover.media_type) ? 'webp' : 'jpg';
        const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
        const stored = await storeDishImage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
          `imports/${name}.${ext}`, Buffer.from(cover.data, 'base64'), cover.media_type || 'image/jpeg');
        if (stored) { recipe.image_url = stored; recipe.image_source = 'video'; }
      } catch (e) { /* no cover; the app generates one */ }
    }
    return res.status(200).json(normalizeRecipeExtras(recipe));
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err && err.message || err) });
  }
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

function postPrompt({ platform, author, title, caption, hasImage, followText, pasted, screenshot }) {
  const where = pasted ? 'the recipe text of a post' : platform === 'other' ? 'a web page' : `a ${PLATFORM_NAMES[platform]} post`;
  const text = screenshot
    ? `THE CAPTION is in the attached image(s): screenshots of the post, taken by the user (in order, if there are several). Read ALL of the caption text in them carefully (ingredients, amounts, instructions, nutrition) and treat that text as the caption. Ignore the app's buttons, like counts, usernames of commenters and the status bar.`
    : `${pasted ? 'THE TEXT THE USER PASTED' : platform === 'youtube' ? 'THE VIDEO DESCRIPTION' : platform === 'other' ? 'THE PAGE TEXT' : 'THE CAPTION'}${author ? ` (by ${platform === 'other' || platform === 'youtube' ? author : '@' + author})` : ''}:
"""
${caption || '(empty)'}
"""`;
  return `You are an expert chef, nutritionist, and grocery cost estimator. A user shared ${where} and wants its recipe.
${title ? `\nTITLE: ${title}\n` : ''}
${text}
${hasImage ? '\nThe attached image is the post\'s cover frame.\n' : ''}
Decide what to make, in this order, and set "basis" to match:

1. "caption_recipe" — the text contains a recipe (an ingredient list, amounts, or cooking instructions). Then THAT is the recipe:
   - Use its dish name.
   - Include EVERY ingredient it lists, with its exact quantities and units. Do not drop, swap or add ingredients. Parts such as a dip, sauce or marinade belong to the dish: list their ingredients too and give them a step.
   - Keep its method: the same order, times and temperatures, rewritten as clear separate steps.
   - If it states servings, calories or macros, use those numbers for servings, calories and nutrition.
   - Fill in only what it leaves out: an amount for "salt" or "a handful", any missing step, equipment, costs, the remaining nutrition fields.
2. "caption_dish" — the text names or clearly describes the dish but gives no recipe. Write an authentic recipe for exactly that dish.
3. "image" — the text says nothing useful about the food${hasImage ? '. Identify the dish in the image and write its recipe' : ''}.

The text always wins over the image. Ignore hashtags, @mentions, promo codes, "link in bio", giveaways and requests to follow or comment.
If neither the text${hasImage ? ' nor the image' : ''} is about a dish or drink someone could make, respond with exactly {"notRecipe":true}.

Estimate each ingredient's cost in USD (US national average) and realistic per-serving nutrition. Respond ONLY with a raw JSON object in EXACTLY this structure:
${RECIPE_JSON}

${rules(followText)}`;
}

function imagePrompt() {
  return `You are an expert chef, nutritionist, and grocery cost estimator. This image is the cover/thumbnail frame of a cooking video. Identify the EXACT dish shown and produce its complete recipe. Be SPECIFIC with the dish name (e.g. "Chicken Biryani" not "Rice with Chicken").

Estimate each ingredient's cost in USD (US national average) and realistic per-serving nutrition. Respond ONLY with a raw JSON object in EXACTLY this structure:
${RECIPE_JSON.replace('"basis":"caption_recipe"', '"basis":"image"')}

${rules(false)}`;
}

async function callAnthropic(key, content) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 3500, temperature: 0.2, messages: [{ role: 'user', content }] })
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
