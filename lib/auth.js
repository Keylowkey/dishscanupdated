// /lib/auth.js — server-side verification of Supabase access tokens.
// Supabase projects sign user tokens with EITHER the legacy HS256 shared secret
// OR (newer default) asymmetric ES256 keys published at the project's JWKS URL.
// This verifier supports both so it keeps working regardless of the project's
// signing setup. It verifies the signature locally (JWKS cached) and returns the
// authenticated user id (`sub`), or null. Fails closed.

import crypto from 'crypto';

function b64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let jwksCache = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  try {
    const url = process.env.SUPABASE_URL;
    if (!url) return jwksCache || [];
    const r = await fetch(`${url}/auth/v1/.well-known/jwks.json`);
    if (!r.ok) return jwksCache || [];
    const data = await r.json();
    jwksCache = Array.isArray(data.keys) ? data.keys : [];
    jwksCachedAt = now;
    return jwksCache;
  } catch (e) {
    return jwksCache || [];
  }
}

export async function verifyToken(accessToken) {
  try {
    if (typeof accessToken !== 'string' || accessToken.length < 20) return null;
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;

    const header = JSON.parse(b64url(h).toString('utf8'));
    const payload = JSON.parse(b64url(p).toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
    const signingInput = `${h}.${p}`;
    const signature = b64url(s);

    if (header.alg === 'HS256') {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) return null;
      const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
      if (expected.length !== signature.length) return null;
      if (!crypto.timingSafeEqual(expected, signature)) return null;
      return payload.sub || null;
    }

    if (header.alg === 'ES256') {
      const keys = await getJwks();
      const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
      if (!jwk) return null;
      const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      // ES256 JWT signatures are raw R||S (IEEE-P1363), not DER.
      const ok = crypto.verify(
        'sha256',
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature
      );
      return ok ? (payload.sub || null) : null;
    }

    return null; // unsupported algorithm
  } catch (e) {
    return null;
  }
}
