// /lib/auth.js — server-side verification of Supabase access tokens.
// Supabase issues HS256 JWTs signed with the project's JWT secret. We verify the
// signature locally (fast, no network round-trip) instead of trusting the payload,
// which is what an unsigned base64 decode does. Requires SUPABASE_JWT_SECRET.

import crypto from 'crypto';

function b64urlToBuffer(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a Supabase access token and return the authenticated user id (the `sub`
 * claim). Returns null if the token is missing, malformed, wrong-algorithm,
 * expired, or the signature does not match. Fails closed if the secret is unset.
 */
export function verifyToken(accessToken) {
  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret || typeof accessToken !== 'string') return null;

    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    // Only accept HS256 (Supabase's default). Reject "none"/asymmetric forgeries.
    const header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
    if (!header || header.alg !== 'HS256') return null;

    // Constant-time signature comparison.
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const given = b64urlToBuffer(sigB64);
    if (expected.length !== given.length) return null;
    if (!crypto.timingSafeEqual(expected, given)) return null;

    const payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
    return payload.sub || null;
  } catch (e) {
    return null;
  }
}
