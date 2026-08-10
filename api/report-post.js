// /api/report-post.js — content reports.
//
// Reports previously went into post_reports and stopped there, so nobody was
// ever told. This records the report AND emails support@ with everything
// needed to act: who reported, who posted, the caption, and the reason.
//
// Deliberately does NOT auto-remove anything — a report is a signal, not a
// verdict. Removal happens through review.

import { verifyToken } from '../lib/auth.js';

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

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  try {
    const { access_token, post_id, reason } = req.body || {};
    if (!access_token) return res.status(401).json({ error: 'Missing token.' });
    const me = await verifyToken(access_token);
    if (!me) return res.status(401).json({ error: 'Invalid or expired session.' });
    if (!post_id) return res.status(400).json({ error: 'Missing post_id.' });

    // Record it first — the email is best-effort on top.
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/post_reports`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ post_id, reporter_id: me, reason: (reason || '').slice(0, 500) || null })
    });
    if (!ins.ok) {
      const t = await ins.text().catch(() => '');
      // A duplicate report from the same person isn't an error worth surfacing.
      if (!/duplicate|unique/i.test(t)) {
        return res.status(502).json({ error: 'Could not file the report.', detail: t.slice(0, 200) });
      }
    }

    // Gather context for the review email.
    let post = null, reporter = null, author = null;
    try {
      const pr = await fetch(
        `${SUPABASE_URL}/rest/v1/posts?select=id,user_id,username,caption,image_url,created_at&id=eq.${encodeURIComponent(post_id)}`,
        { headers: H });
      post = (pr.ok ? await pr.json() : [])[0] || null;
      const ids = [me, post && post.user_id].filter(Boolean);
      if (ids.length) {
        const ur = await fetch(
          `${SUPABASE_URL}/rest/v1/user_profiles?select=id,username,email&id=in.${encodeURIComponent('(' + ids.join(',') + ')')}`,
          { headers: H });
        const rows = ur.ok ? await ur.json() : [];
        reporter = rows.find(r => r.id === me) || null;
        author = post ? rows.find(r => r.id === post.user_id) || null : null;
      }
    } catch (e) { /* email will just carry less detail */ }

    // How many times this post has been reported — useful for triage.
    let reportCount = 1;
    try {
      const cr = await fetch(
        `${SUPABASE_URL}/rest/v1/post_reports?select=id&post_id=eq.${encodeURIComponent(post_id)}`,
        { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
      const cc = cr.headers.get('content-range') || '';
      if (cc.includes('/')) reportCount = parseInt(cc.split('/')[1], 10) || 1;
    } catch (e) { /* keep 1 */ }

    if (process.env.RESEND_API_KEY) {
      const html = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;">
          <h2 style="margin:0 0 4px;">Content report</h2>
          <p style="color:#666;margin:0 0 18px;">Reported <b>${reportCount}</b> time${reportCount === 1 ? '' : 's'} in total.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:6px 0;color:#666;width:130px;">Reported by</td><td>@${esc(reporter && reporter.username)}${reporter && reporter.email ? ' &lt;' + esc(reporter.email) + '&gt;' : ''}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Post author</td><td>@${esc((author && author.username) || (post && post.username))}${author && author.email ? ' &lt;' + esc(author.email) + '&gt;' : ''}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Post ID</td><td style="font-family:monospace;font-size:12px;">${esc(post_id)}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Posted</td><td>${esc(post && post.created_at)}</td></tr>
            <tr><td style="padding:6px 0;color:#666;vertical-align:top;">Reason given</td><td>${esc(reason) || '<i style="color:#999;">none given</i>'}</td></tr>
            <tr><td style="padding:6px 0;color:#666;vertical-align:top;">Caption</td><td>${esc(post && post.caption) || '<i style="color:#999;">no caption</i>'}</td></tr>
          </table>
          ${post && post.image_url && /^https?:/i.test(post.image_url)
            ? `<p style="margin-top:16px;"><img src="${esc(post.image_url)}" alt="Reported photo" style="max-width:320px;border-radius:8px;" /></p>`
            : '<p style="margin-top:16px;color:#999;font-size:13px;">(Photo is stored inline and not shown here — open the post in the app to view it.)</p>'}
          <p style="margin-top:22px;color:#666;font-size:13px;">Nothing has been removed automatically. Review before taking action.</p>
        </div>`;
      try {
        const mr = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: 'Capture & Cook <noreply@captureandcook.com>',
            to: 'support@captureandcook.com',
            subject: `Content report — @${(author && author.username) || (post && post.username) || 'unknown'}${reportCount > 1 ? ` (${reportCount} reports)` : ''}`,
            html
          })
        });
        if (!mr.ok) console.error('report email failed:', mr.status, await mr.text().catch(() => ''));
      } catch (e) { console.error('report email error:', e); }
    } else {
      console.error('RESEND_API_KEY missing — report recorded but no email sent.');
    }

    return res.status(200).json({ ok: true, reportCount });
  } catch (e) {
    return res.status(500).json({ error: 'Server error.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
