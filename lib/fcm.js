// lib/fcm.js — send push notifications to Android devices.
//
// The iOS counterpart (lib/apns.js) signs a short-lived ES256 JWT and talks to
// Apple over HTTP/2. Firebase works differently: the FCM HTTP v1 API wants a
// Google OAuth2 access token, which you get by signing a JWT with a service
// account's RSA key and exchanging it at Google's token endpoint. The legacy
// server key that skipped all this was retired by Google in 2024.
//
// Env required:
//   FCM_PROJECT_ID        Firebase project id
//   FCM_CLIENT_EMAIL      service account email (…@….iam.gserviceaccount.com)
//   FCM_PRIVATE_KEY       the service account's private key (PEM)
//
// FCM_PRIVATE_KEY goes through the same normaliser as the APNs key, because
// environment-variable UIs mangle PEMs in exactly the same ways.

import crypto from 'node:crypto';
import { normalizePem } from './apns.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

let cachedToken = null;
let cachedUntil = 0;

/**
 * Exchange the service-account key for an OAuth2 access token.
 * Google issues these for an hour; reuse for 50 minutes.
 */
async function accessToken() {
  const email = process.env.FCM_CLIENT_EMAIL;
  const rawKey = process.env.FCM_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error('FCM env vars missing');
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600
  }));
  const signingInput = `${header}.${claims}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput),
    crypto.createPrivateKey(normalizePem(rawKey)));
  const assertion = `${signingInput}.${b64url(sig)}`;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!r.ok) throw new Error('FCM auth failed: ' + (await r.text()).slice(0, 160));
  const data = await r.json();
  cachedToken = data.access_token;
  cachedUntil = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

/**
 * Push to Android device tokens.
 * Mirrors sendPush() in apns.js: { sent, failed, invalid[] }, where `invalid`
 * lists tokens the caller should delete so dead devices aren't retried forever.
 */
export async function sendFcm(tokens, { title, body, data }) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { sent: 0, failed: 0, invalid: [] };

  const projectId = process.env.FCM_PROJECT_ID;
  if (!projectId) {
    console.error('FCM not configured: FCM_PROJECT_ID missing');
    return { sent: 0, failed: list.length, invalid: [] };
  }

  let jwt;
  try { jwt = await accessToken(); }
  catch (e) {
    console.error('FCM auth error:', e.message);
    return { sent: 0, failed: list.length, invalid: [] };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  // FCM data values must all be strings, unlike the APNs payload.
  const stringData = {};
  Object.entries(data || {}).forEach(([k, v]) => { stringData[k] = String(v); });

  // v1 has no multicast endpoint; one request per token, run together.
  const results = await Promise.all(list.map(async (token) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: stringData,
            android: {
              priority: 'HIGH',
              notification: {
                sound: 'default',
                channel_id: 'default',
                default_vibrate_timings: true
              }
            }
          }
        })
      });
      if (r.ok) return { ok: true, token };
      const txt = await r.text();
      return { ok: false, token, status: r.status, reason: txt.slice(0, 160) };
    } catch (e) {
      return { ok: false, token, status: 0, reason: String(e.message || e) };
    }
  }));

  // A token is dead when the app was uninstalled or the token was reissued.
  const invalid = results
    .filter(r => !r.ok && (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(r.reason || '')))
    .map(r => r.token);
  const sent = results.filter(r => r.ok).length;
  results.filter(r => !r.ok).forEach(r => console.error('FCM fail:', r.status, r.reason));

  return { sent, failed: results.length - sent, invalid };
}
