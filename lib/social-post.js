// lib/social-post.js — read what a shared post actually says.
//
// A recipe video's recipe is usually written in its caption. This pulls the
// caption (and the cover, kept as the dish's picture) out of a shared link:
//
//   Instagram  the post page's og:description, else its /embed/captioned page
//   TikTok     the page's rehydration data (itemStruct.desc)
//   YouTube    title + full description
//   anything   schema.org Recipe data if the page has it (recipe blogs),
//              else og:title / og:description
//
// Instagram refuses data-centre IPs now and then, so the app can read the
// same pages on the phone and pass what it found as `devicePost`; the
// parsing still happens here, in one place.
//
// readPost(url, devicePost?) → { platform, caption, author, title, coverUrl, read }
//   read: true when the post's own text was reached (even if it is empty).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MAX_CAPTION = 4000;

export function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  return 'other';
}

// True only if the image looks like real post CONTENT (not a brand logo or a
// static asset served on a login/blocked page). Also what limits which hosts
// we will fetch an app-supplied cover from.
export function isRealThumb(u, platform) {
  if (!/^https:\/\//i.test(u || '')) return false;
  if (/\/static\/|logo|sprite|favicon|\bicon\b|placeholder/i.test(u)) return false;
  if (platform === 'instagram') return /^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//i.test(u);
  if (platform === 'tiktok') return /^https:\/\/[^/]*(tiktokcdn[^/]*\.com|ibyteimg\.com|muscdn\.com)\//i.test(u);
  if (platform === 'facebook') return /^https:\/\/[^/]*fbcdn\.net\//i.test(u);
  if (platform === 'youtube') return /^https:\/\/[^/]*(ytimg\.com|ggpht\.com)\//i.test(u);
  return true;
}

export function decodeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function safeChar(n) { try { return String.fromCodePoint(n); } catch (e) { return ''; } }

export function extractOg(html, prop) {
  const res = [
    new RegExp('<meta[^>]+(?:property|name)=["\']og:' + prop + '["\'][^>]*content="([^"]*)"', 'i'),
    new RegExp('<meta[^>]+(?:property|name)=["\']og:' + prop + '["\'][^>]*content=\'([^\']*)\'', 'i'),
    new RegExp('<meta[^>]+content="([^"]*)"[^>]*(?:property|name)=["\']og:' + prop + '["\']', 'i'),
    new RegExp('<meta[^>]+content=\'([^\']*)\'[^>]*(?:property|name)=["\']og:' + prop + '["\']', 'i')
  ];
  for (const re of res) { const m = String(html || '').match(re); if (m) return decodeHtml(m[1]); }
  return '';
}

// Tidy a caption: real line breaks, no runs of blank lines, sane length.
export function cleanCaption(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim().slice(0, MAX_CAPTION);
}

// Does a caption say anything beyond tags and mentions?
export function captionHasWords(caption) {
  const words = String(caption || '').replace(/[#@][\w.]+/g, ' ').replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return words.length >= 12;
}

// ── Instagram ──
// og:description reads: 293K likes, 2,396 comments - itzpmartin on August 18, 2026: "the caption".
// og:title reads:       Display Name on Instagram: "the caption"
export function parseInstagramMeta(description, title) {
  const out = { caption: '', author: '' };
  const d = String(description || '').trim();
  let m = d.match(/^[\d.,]+[KMB]?\s+likes?,\s*[\d.,]+[KMB]?\s+comments?\s+-\s+([\w.]+)\s+on\s+[^:]{3,40}:\s*["“]([\s\S]*)$/i);
  if (m) {
    out.author = m[1];
    out.caption = m[2];
  } else {
    m = d.match(/^([\w.]+)\s+on\s+[^:]{3,40}:\s*["“]([\s\S]*)$/i);     // no like counts shown
    if (m) { out.author = m[1]; out.caption = m[2]; }
  }
  if (!out.caption) {
    const t = String(title || '').match(/\bon Instagram:\s*["“]([\s\S]*)$/i);
    if (t) out.caption = t[1];
  }
  // Drop the closing quote (and Instagram's trailing full stop).
  out.caption = cleanCaption(out.caption.replace(/["”]\s*\.?\s*$/, ''));
  return out;
}
export function parseInstagramPage(html) {
  const meta = parseInstagramMeta(extractOg(html, 'description'), extractOg(html, 'title'));
  return { ...meta, coverUrl: extractOg(html, 'image'), read: !!(extractOg(html, 'description') || extractOg(html, 'title')) };
}
// The embed page: <div class="Caption"><a class="CaptionUsername">user</a><br/><br/>caption…<div class="CaptionComments">
export function parseInstagramEmbed(html) {
  const h = String(html || '');
  const out = { caption: '', author: '', coverUrl: '', read: false };
  const block = h.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i);
  if (block) {
    out.read = true;
    const user = block[1].match(/<a class="CaptionUsername"[^>]*>([^<]*)<\/a>/i);
    if (user) out.author = decodeHtml(user[1]).trim();
    const body = block[1].replace(/<a class="CaptionUsername"[^>]*>[^<]*<\/a>/i, '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    out.caption = cleanCaption(decodeHtml(body));
  }
  const img = h.match(/<img[^>]+class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i) || h.match(/<img[^>]+src="([^"]+)"[^>]*class="EmbeddedMediaImage"/i);
  if (img) out.coverUrl = decodeHtml(img[1]);
  if (!out.read && /EmbeddedMedia|class="Embed/i.test(h)) out.read = true;   // a real embed with no caption
  return out;
}
export function instagramEmbedUrl(url) {
  const m = String(url).match(/instagram\.com\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)/i);
  return m ? `https://www.instagram.com/${m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase()}/${m[2]}/embed/captioned/` : '';
}

// ── TikTok ──
export function parseTikTokPage(html) {
  const h = String(html || '');
  const out = { caption: '', author: '', coverUrl: '', read: false };
  const m = h.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const scope = (JSON.parse(m[1]) || {}).__DEFAULT_SCOPE__ || {};
      const item = ((scope['webapp.video-detail'] || {}).itemInfo || {}).itemStruct;
      if (item) {
        out.read = true;
        out.caption = cleanCaption(item.desc || '');
        out.author = (item.author && item.author.uniqueId) || '';
        const images = item.imagePost && item.imagePost.images;
        out.coverUrl = (item.video && (item.video.cover || item.video.originCover)) ||
          (images && images[0] && images[0].imageURL && (images[0].imageURL.urlList || [])[0]) || '';
      }
    } catch (e) { /* fall through to the meta tags */ }
  }
  if (!out.read) {
    const d = extractOg(h, 'description');
    if (d) { out.read = true; out.caption = cleanCaption(d); }
  }
  if (!out.coverUrl) out.coverUrl = extractOg(h, 'image');
  return out;
}

// ── YouTube ──
export function parseYouTubePage(html) {
  const h = String(html || '');
  let description = '';
  const m = h.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (m) { try { description = JSON.parse('"' + m[1] + '"'); } catch (e) { description = m[1].replace(/\\n/g, '\n'); } }
  if (!description) description = extractOg(h, 'description');
  const owner = h.match(/"ownerChannelName":"((?:\\.|[^"\\])*)"/);
  let author = '';
  if (owner) { try { author = JSON.parse('"' + owner[1] + '"'); } catch (e) { author = owner[1]; } }
  const title = extractOg(h, 'title');
  return { caption: cleanCaption(description), title, author, coverUrl: extractOg(h, 'image'), read: !!(title || description) };
}

// ── Recipe sites: schema.org Recipe in JSON-LD ──
function findRecipeNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; } return null; }
  if (typeof node !== 'object') return null;
  const t = node['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return node;
  return findRecipeNode(node['@graph'], depth + 1) || findRecipeNode(node.mainEntity, depth + 1);
}
function stepsText(x, out = []) {
  if (!x) return out;
  if (typeof x === 'string') { out.push(x); return out; }
  if (Array.isArray(x)) { x.forEach(i => stepsText(i, out)); return out; }
  if (x.itemListElement) return stepsText(x.itemListElement, out);
  if (x.text) out.push(String(x.text)); else if (x.name) out.push(String(x.name));
  return out;
}
export function parseRecipeSchema(html) {
  const h = String(html || '');
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(h))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const r = findRecipeNode(data);
    if (!r) continue;
    const strip = s => decodeHtml(String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map(strip).filter(Boolean);
    const steps = stepsText(r.recipeInstructions).map(strip).filter(Boolean);
    if (!ingredients.length && !steps.length) continue;
    const n = r.nutrition || {};
    const lines = [strip(r.name)];
    if (r.recipeYield) lines.push('Makes: ' + strip([].concat(r.recipeYield)[0]));
    if (n.calories) lines.push('Nutrition per serving: ' + [n.calories, n.proteinContent && 'protein ' + n.proteinContent,
      n.carbohydrateContent && 'carbs ' + n.carbohydrateContent, n.fatContent && 'fat ' + n.fatContent].filter(Boolean).map(strip).join(', '));
    if (ingredients.length) lines.push('', 'Ingredients:', ...ingredients.map(i => '- ' + i));
    if (steps.length) lines.push('', 'Instructions:', ...steps.map((s, i) => (i + 1) + '. ' + s));
    const image = [].concat(r.image || [])[0];
    const author = [].concat(r.author || [])[0];
    return {
      caption: cleanCaption(lines.join('\n')), title: strip(r.name),
      author: strip(author && (author.name || author)) || '',
      coverUrl: (image && (image.url || image)) || '', read: true
    };
  }
  return null;
}
export function parseGenericPage(html) {
  const recipe = parseRecipeSchema(html);
  if (recipe) { if (!/^https:\/\//i.test(recipe.coverUrl)) recipe.coverUrl = extractOg(html, 'image'); return recipe; }
  const title = extractOg(html, 'title'), description = extractOg(html, 'description');
  return { caption: cleanCaption(description), title, author: '', coverUrl: extractOg(html, 'image'), read: !!(title || description) };
}

async function fetchHtml(url, ua = UA) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return '';
    return await r.text();
  } catch (e) { return ''; }
}

// What the app read on the phone: raw strings, parsed here like our own.
function fromDevice(platform, d) {
  if (!d || typeof d !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const image = s(d.image, 2000);
  let post = null;
  if (platform === 'instagram') {
    const meta = parseInstagramMeta(s(d.description, 8000), s(d.title, 8000));
    const embedCaption = cleanCaption(s(d.caption, 8000));
    post = {
      caption: embedCaption.length > meta.caption.length ? embedCaption : meta.caption,
      author: meta.author || s(d.author, 60).replace(/[^\w.]/g, ''),
      read: !!(d.description || d.title || d.caption || d.read)
    };
  } else if (platform === 'tiktok') {
    post = { caption: cleanCaption(s(d.caption, 8000) || s(d.description, 8000)), author: s(d.author, 60).replace(/[^\w.]/g, ''), read: !!(d.caption || d.description || d.read) };
  }
  if (!post) return null;
  post.coverUrl = isRealThumb(image, platform) ? image : '';
  return post;
}

export async function readPost(url, devicePost) {
  const platform = detectPlatform(url);
  let post = fromDevice(platform, devicePost);

  if (!post || !post.read || !post.coverUrl) {
    let server = null;
    if (platform === 'instagram') {
      server = parseInstagramPage(await fetchHtml(url));
      if (!server.caption) {
        const embed = instagramEmbedUrl(url);
        const viaEmbed = embed ? parseInstagramEmbed(await fetchHtml(embed)) : null;
        if (viaEmbed && (viaEmbed.read || viaEmbed.coverUrl)) {
          server = { caption: viaEmbed.caption, author: viaEmbed.author || server.author, coverUrl: viaEmbed.coverUrl || server.coverUrl, read: viaEmbed.read || server.read };
        }
      }
      if (!server.read && !server.coverUrl) server = parseInstagramPage(await fetchHtml(url, BOT_UA));
    } else if (platform === 'tiktok') {
      server = parseTikTokPage(await fetchHtml(url));
    } else if (platform === 'youtube') {
      server = parseYouTubePage(await fetchHtml(url));
      if (!server.title) {
        try {
          const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
          if (o.ok) { const j = await o.json(); server.title = j.title || ''; server.author = server.author || j.author_name || ''; server.read = server.read || !!j.title; }
        } catch (e) { /* ignore */ }
      }
    } else {
      server = parseGenericPage(await fetchHtml(url));
    }
    // Keep whichever side read more; fill gaps from the other.
    if (!post || !post.read || (server.caption || '').length > (post.caption || '').length) {
      post = { ...server, coverUrl: server.coverUrl || (post && post.coverUrl) || '', author: server.author || (post && post.author) || '' };
    } else {
      post.coverUrl = post.coverUrl || server.coverUrl || '';
      post.author = post.author || server.author || '';
    }
  }

  return {
    platform,
    caption: cleanCaption(post.caption),
    author: String(post.author || '').slice(0, 60),
    title: String(post.title || '').slice(0, 200),
    coverUrl: isRealThumb(post.coverUrl, platform) ? post.coverUrl : '',
    read: !!post.read
  };
}
