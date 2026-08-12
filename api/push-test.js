// /api/push-test.js — prove the push pipeline works, end to end.
//
// Reports whether the APNs credentials are present and usable, how many devices
// the caller has registered, and (optionally) sends a real test push to them.
// Never returns the key material itself — only whether it parses.

import { verifyToken } from '../lib/auth.js';
import { sendPush } from '../lib/apns.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Server missing config.' });
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const { access_token, send } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });

    // 1. Are the credentials present and does the key actually parse?
    const diag = {
      APNS_KEY_ID: !!process.env.APNS_KEY_ID,
      APNS_TEAM_ID: !!process.env.APNS_TEAM_ID,
      APNS_PRIVATE_KEY: !!process.env.APNS_PRIVATE_KEY,
      keyParses: false,
      keyType: null,
      gateway: process.env.APNS_PRODUCTION === '1' ? 'production' : 'sandbox'
    };
    if (process.env.APNS_PRIVATE_KEY) {
      try {
        let pem = String(process.env.APNS_PRIVATE_KEY).replace(/\\n/g, '\n').trim();
        if (!pem.includes('\n')) {
          const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
          if (m) {
            const body = m[2].replace(/\s+/g, '');
            pem = `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) || []).join('\n')}\n-----END ${m[1]}-----`;
          }
        }
        const k = crypto.createPrivateKey(pem);
        diag.keyParses = true;
        diag.keyType = k.asymmetricKeyType;
      } catch (e) {
        diag.keyError = String(e.message || e).slice(0, 120);
      }
    }

    // 2. How many devices has this user registered?
    let tokens = [];
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/device_tokens?select=token&user_id=eq.${me}`, { headers: H });
      tokens = r.ok ? (await r.json()).map(t => t.token) : [];
    } catch (e) { /* leave empty */ }
    diag.devicesRegistered = tokens.length;

    // 3. Optionally fire a real push at them.
    if (send && tokens.length && diag.keyParses) {
      const out = await sendPush(tokens, {
        title: 'Capture & Cook',
        body: 'Push notifications are working. 🍳',
        data: { type: 'test' }
      });
      diag.pushResult = out;
    }

    return res.status(200).json(diag);
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
