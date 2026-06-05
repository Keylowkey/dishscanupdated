// /api/support.js — Capture & Cook Support Ticket Handler
// Logs ticket to Supabase, notifies support@, auto-replies to user

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, message, _honeypot } = req.body;

  // --- Spam check (honeypot field must be empty) ---
  if (_honeypot) {
    // Silently succeed so bots don't know they were caught
    return res.status(200).json({ success: true });
  }

  // --- Basic validation ---
  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (message.trim().length < 10) {
    return res.status(400).json({ error: 'Message must be at least 10 characters.' });
  }

  let ticketId;

  try {
    // ── 1. Log ticket to Supabase ──────────────────────────────────────────────
    const supabaseRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/support_tickets`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          message: message.trim(),
          status: 'open',
        }),
      }
    );

    if (!supabaseRes.ok) {
      const err = await supabaseRes.text();
      throw new Error(`Supabase error: ${err}`);
    }

    const [ticket] = await supabaseRes.json();
    ticketId = ticket.id;

    // ── 2. Notify support@captureandcook.com ───────────────────────────────────
    await sendEmail({
      from: 'Capture & Cook <noreply@captureandcook.com>',
      to: 'support@captureandcook.com',
      replyTo: email.trim(),  // Replying in Gmail goes straight to the user
      subject: `New Support Ticket — ${name.trim()}`,
      html: supportNotificationHTML({ name, email, message, ticketId }),
    });

    // ── 3. Auto-reply confirmation to user ─────────────────────────────────────
    await sendEmail({
      from: 'Capture & Cook Support <noreply@captureandcook.com>',
      to: email.trim(),
      subject: "We got your message — we'll be in touch soon!",
      html: userConfirmationHTML({ name, message }),
    });

    return res.status(200).json({ success: true, ticketId });

  } catch (error) {
    console.error('Support ticket error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── Resend helper ────────────────────────────────────────────────────────────
async function sendEmail({ from, to, replyTo, subject, html }) {
  const body = { from, to, subject, html };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }

  return res.json();
}

// ── Email Templates ──────────────────────────────────────────────────────────

function supportNotificationHTML({ name, email, message, ticketId }) {
  const submittedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Detroit',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, sans-serif; background: #f5f5f5; margin: 0; padding: 24px;">
      <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; border: 1px solid #e5e5e5;">
        <div style="background: #ff6b35; padding: 24px 32px;">
          <h1 style="margin: 0; color: #fff; font-size: 18px; font-weight: 600;">📬 New Support Ticket</h1>
        </div>
        <div style="padding: 28px 32px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #333;">
            <tr>
              <td style="padding: 8px 0; color: #888; width: 90px; vertical-align: top;">Ticket ID</td>
              <td style="padding: 8px 0; font-family: monospace; font-size: 12px; color: #555;">${ticketId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #888; vertical-align: top;">Name</td>
              <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(name)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #888; vertical-align: top;">Email</td>
              <td style="padding: 8px 0;"><a href="mailto:${escapeHtml(email)}" style="color: #ff6b35;">${escapeHtml(email)}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #888; vertical-align: top;">Submitted</td>
              <td style="padding: 8px 0;">${submittedAt} ET</td>
            </tr>
          </table>
          <div style="margin-top: 20px; padding: 16px; background: #fafafa; border-radius: 8px; border-left: 3px solid #ff6b35;">
            <p style="margin: 0 0 6px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Message</p>
            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #222; white-space: pre-wrap;">${escapeHtml(message)}</p>
          </div>
          <p style="margin: 20px 0 0; font-size: 13px; color: #888;">
            💡 Hit <strong>Reply</strong> to respond directly to ${escapeHtml(name)}.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function userConfirmationHTML({ name, message }) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, sans-serif; background: #f5f5f5; margin: 0; padding: 24px;">
      <div style="max-width: 540px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; border: 1px solid #e5e5e5;">
        <div style="background: #ff6b35; padding: 24px 32px; text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">🍽️</div>
          <h1 style="margin: 0; color: #fff; font-size: 20px; font-weight: 700;">Capture & Cook</h1>
          <p style="margin: 6px 0 0; color: rgba(255,255,255,0.85); font-size: 13px;">Support Team</p>
        </div>
        <div style="padding: 32px;">
          <h2 style="margin: 0 0 12px; font-size: 18px; color: #111;">Hey ${escapeHtml(name.split(' ')[0])}, we got your message! 👋</h2>
          <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #444;">
            Thanks for reaching out. We've received your support request and will get back to you as soon as we can — usually within 1–2 business days.
          </p>
          <div style="padding: 16px; background: #fafafa; border-radius: 8px; border-left: 3px solid #ff6b35; margin-bottom: 24px;">
            <p style="margin: 0 0 6px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Your message</p>
            <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #555; white-space: pre-wrap;">${escapeHtml(message)}</p>
          </div>
          <p style="margin: 0; font-size: 13px; color: #888; line-height: 1.6;">
            If your issue is urgent or you need to add more details, just reply to this email and it'll go straight to our team.
          </p>
        </div>
        <div style="padding: 16px 32px; background: #fafafa; border-top: 1px solid #eee; text-align: center;">
          <p style="margin: 0; font-size: 12px; color: #bbb;">© ${new Date().getFullYear()} Capture & Cook · All rights reserved</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

// Prevent XSS in email HTML
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
