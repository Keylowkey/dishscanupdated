// lib/guard.js — the gate in front of every endpoint that costs money.
//
// The AI endpoints call Claude on each request, and /api/places bills Google.
// They were reachable by anyone who knew the URL: no account, no token, no
// ceiling. A shell script could bill the project's accounts indefinitely.
//
// IMPORTANT — why this does not simply require a login:
// The version already on the App Store does not send a session token on these
// calls, because there was nothing to send it to. Hard-requiring auth would
// break the app for every user currently running the shipped build. So this
// runs in two tiers:
//
//   signed in    → generous per-user hourly ceiling
//   not signed in→ strict per-IP hourly ceiling (kills bulk abuse, leaves a
//                  normal person on the old build entirely unaffected)
//
// Once the updated client is out and adopted, set REQUIRE_AUTH=1 in the
// environment and anonymous calls are refused outright — no code change.
//
// Rate limiting is best-effort: if the counter table is missing or Supabase is
// unreachable, the call is allowed. Never lock real users out over telemetry.

import { verifyToken } from './auth.js';

const WINDOW_SEC = 3600;              // rolling hour
const ANON_SHARE = 0.25;              // anonymous callers get a quarter of the ceiling

export function cors(req, res, methods = 'POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return true; }
  return false;
}

function callerIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}

// Count this subject's calls in the window and record the current one.
// Returns true when the subject is over its ceiling.
async function overLimit(subject, bucket, max) {
  const U = process.env.SUPABASE_URL;
  const K = process.env.SUPABASE_SERVICE_KEY;
  if (!U || !K) return false;
  const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - WINDOW_SEC * 1000).toISOString();

  try {
    const r = await fetch(
      `${U}/rest/v1/rate_limits?select=id&subject=eq.${encodeURIComponent(subject)}` +
      `&bucket=eq.${encodeURIComponent(bucket)}&created_at=gte.${since}`,
      { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } }
    );
    if (!r.ok) return false; // table missing or transient error → fail open
    const used = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
    if (Number.isFinite(used) && used >= max) return true;

    await fetch(`${U}/rest/v1/rate_limits`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ subject, bucket })
    });
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * Authenticate where possible, throttle always.
 * Returns { uid, anon } to proceed, or null after having sent an error response.
 */
export async function guard(req, res, { bucket, max = 60 } = {}) {
  const token = (req.body && req.body.access_token) ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  const uid = token ? await verifyToken(token) : null;

  if (!uid && process.env.REQUIRE_AUTH === '1') {
    res.status(401).json({ error: 'Please sign in to use this feature.' });
    return null;
  }

  const subject = uid ? `u:${uid}` : `ip:${callerIp(req)}`;
  const ceiling = uid ? max : Math.max(5, Math.round(max * ANON_SHARE));

  if (await overLimit(subject, bucket, ceiling)) {
    res.status(429).json({
      error: uid
        ? "You've hit the hourly limit for this feature. Try again shortly."
        : 'Too many requests. Please sign in to the app and try again.'
    });
    return null;
  }
  return { uid, anon: !uid };
}
