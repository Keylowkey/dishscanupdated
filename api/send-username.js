// /api/send-username.js — Capture & Cook "Forgot username" handler
// Looks up the username for a given email in Supabase and emails it via Resend.
// Always returns a neutral success so it never reveals whether an account exists.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  const clean = (email || '').trim().toLowerCase();

  // Neutral response — do not reveal whether an account exists for this email.
  const neutral = () => res.status(200).json({ success: true });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!clean || !emailRegex.test(clean)) return neutral();

  try {
    // Look up the username for this email. The service key bypasses RLS.
    const lookupUrl =
      `${process.env.SUPABASE_URL}/rest/v1/user_profiles` +
      `?email=eq.${encodeURIComponent(clean)}&select=username,full_name`;

    const lookupRes = await fetch(lookupUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });

    if (lookupRes.ok) {
      const rows = await lookupRes.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.username) {
        await sendEmail({
          to: clean,
          subject: 'Your Capture & Cook username',
          html: usernameEmailHTML({ username: row.username, name: row.full_name || '' }),
        });
      }
    }
  } catch (error) {
    // Log but still return neutral success so the client shows a consistent message.
    console.error('send-username error:', error);
  }

  return neutral();
}

// ── Resend helper ────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Capture & Cook <noreply@captureandcook.com>',
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  return res.json();
}

// ── Email template ───────────────────────────────────────────────────────────
function usernameEmailHTML({ username, name }) {
  const greeting = name ? `Hey ${escapeHtml(name.split(' ')[0])},` : 'Hey there,';
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, sans-serif; background: #f5f5f5; margin: 0; padding: 24px;">
      <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; border: 1px solid #e5e5e5;">
        <div style="background: #2ecc71; padding: 24px 32px; text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">🍽️</div>
          <h1 style="margin: 0; color: #fff; font-size: 20px; font-weight: 700;">Capture &amp; Cook</h1>
        </div>
        <div style="padding: 32px;">
          <h2 style="margin: 0 0 12px; font-size: 18px; color: #111;">${greeting}</h2>
          <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #444;">
            You asked us to remind you of your username. Here it is:
          </p>
          <div style="padding: 18px; background: #f2fbf6; border-radius: 10px; border-left: 3px solid #2ecc71; margin-bottom: 24px; text-align: center;">
            <div style="font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Your username</div>
            <div style="font-size: 22px; font-weight: 800; color: #1a7a44;">@${escapeHtml(username)}</div>
          </div>
          <p style="margin: 0; font-size: 13px; color: #888; line-height: 1.6;">
            You can sign in with your email and password. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
