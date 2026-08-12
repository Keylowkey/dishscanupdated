// lib/apns.js — send Apple Push Notifications.
//
// APNs requires HTTP/2, which fetch() on Node does not speak, so this uses the
// built-in http2 module directly. Auth is a short-lived ES256 JWT signed with
// the .p8 key — the same signing scheme as the Sign in with Apple secret.
//
// Env required:
//   APNS_KEY_ID       the 10-char Key ID of the .p8
//   APNS_TEAM_ID      your Apple Team ID
//   APNS_PRIVATE_KEY  contents of the .p8 (newlines may be literal "\n")
//   APNS_BUNDLE_ID    defaults to com.captureandcook.app
//   APNS_PRODUCTION   "1" for the production gateway (App Store / TestFlight builds)

import http2 from 'node:http2';
import crypto from 'node:crypto';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// Environment variable UIs mangle PEM keys in predictable ways: literal "\n"
// instead of newlines, or the whole thing flattened onto one line with spaces.
// Rebuild a valid PEM from whatever we're given rather than failing at 3am.
function normalizePem(raw) {
  let s = String(raw).replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  // Strip a wrapping pair of quotes some env-var UIs add on paste.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.includes('\n')) return s;                    // already well-formed
  const m = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return s;                                  // unrecognised — let crypto complain
  const label = m[1];
  const body = m[2].replace(/\s+/g, '');             // strip the spaces the UI inserted
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

let cachedToken = null;
let cachedAt = 0;

// APNs rejects tokens older than an hour and rate-limits regeneration, so reuse
// for ~50 minutes.
function providerToken() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  let pem = process.env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !pem) throw new Error('APNs env vars missing');
  if (cachedToken && Date.now() - cachedAt < 50 * 60 * 1000) return cachedToken;

  pem = normalizePem(pem);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363'
  });
  cachedToken = `${signingInput}.${b64url(sig)}`;
  cachedAt = Date.now();
  return cachedToken;
}

// Send one notification. Resolves { ok, status, reason, token }.
function sendOne(session, deviceToken, payload, jwt, bundleId) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = data ? (JSON.parse(data).reason || '') : ''; } catch (e) { reason = data.slice(0, 80); }
      resolve({ ok: status === 200, status, reason, token: deviceToken });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, reason: String(e.message || e), token: deviceToken }));
    req.end(body);
  });
}

/**
 * Push to many device tokens at once over a single HTTP/2 connection.
 * Returns { sent, failed, invalid[] } — invalid tokens should be deleted by
 * the caller so dead devices don't get retried forever.
 */
export async function sendPush(tokens, { title, body, data }) {
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!list.length) return { sent: 0, failed: 0, invalid: [] };

  let jwt;
  try { jwt = providerToken(); }
  catch (e) { console.error('APNs not configured:', e.message); return { sent: 0, failed: list.length, invalid: [] }; }

  const host = process.env.APNS_PRODUCTION === '1'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
  const bundleId = process.env.APNS_BUNDLE_ID || 'com.captureandcook.app';

  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
      'content-available': 1
    },
    ...(data || {})
  };

  const session = http2.connect(host);
  const results = await new Promise((resolve) => {
    session.on('error', (e) => {
      console.error('APNs connection error:', e.message);
      resolve(list.map(t => ({ ok: false, status: 0, reason: 'connection', token: t })));
    });
    Promise.all(list.map(t => sendOne(session, t, payload, jwt, bundleId))).then(resolve);
  });
  try { session.close(); } catch (e) { /* already closed */ }

  const invalid = results
    .filter(r => !r.ok && /BadDeviceToken|Unregistered/i.test(r.reason))
    .map(r => r.token);
  const sent = results.filter(r => r.ok).length;
  results.filter(r => !r.ok).forEach(r => console.error('APNs fail:', r.status, r.reason));

  return { sent, failed: results.length - sent, invalid };
}
