// lib/notify.js — one place that records a notification AND pushes it.
//
// Every notification path (comment, reaction, follow, share) should call this
// so the in-app bell and the lock screen never disagree.

import { sendPush } from './apns.js';

// Human wording for each type, mirroring what the in-app bell shows.
function wording(type, actor, preview) {
  const who = '@' + (actor || 'someone');
  switch (type) {
    case 'comment':         return { title: 'New comment', body: `${who} commented${preview ? ': ' + preview : ' on your post'}` };
    case 'mention':         return { title: 'You were mentioned', body: `${who} mentioned you${preview ? ': ' + preview : ''}` };
    case 'reaction':        return { title: 'New reaction', body: `${who} reacted to your photo` };
    case 'follow':          return { title: 'New follower', body: `${who} started following you` };
    case 'follow_request':  return { title: 'Follow request', body: `${who} asked to follow you` };
    case 'follow_accepted': return { title: 'Request accepted', body: `${who} accepted your follow request` };
    case 'recipe':          return { title: 'Recipe shared with you', body: `${who} sent you${preview ? ' ' + preview : ' a recipe'}` };
    default:                return { title: 'Capture & Cook', body: preview || 'You have a new notification' };
  }
}

/**
 * @param {object} cfg   { SUPABASE_URL, headers }
 * @param {object[]} rows  notification rows: { recipient_id, actor_id, actor_username, type, post_id?, preview?, reaction_type? }
 */
export async function notifyAll(cfg, rows) {
  const list = (rows || []).filter(r => r && r.recipient_id && r.type);
  if (!list.length) return { inserted: 0, pushed: 0 };
  const { SUPABASE_URL, headers } = cfg;

  // 1. Record for the in-app bell. This must not be skipped if push fails.
  let inserted = 0;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(list)
    });
    if (r.ok) inserted = list.length;
    else console.error('notification insert failed:', r.status, await r.text().catch(() => ''));
  } catch (e) { console.error('notification insert error:', e); }

  // 2. Push to each recipient's devices.
  let pushed = 0;
  try {
    const recipients = [...new Set(list.map(r => r.recipient_id))];
    const inList = encodeURIComponent('(' + recipients.join(',') + ')');
    const tr = await fetch(
      `${SUPABASE_URL}/rest/v1/device_tokens?select=token,user_id&user_id=in.${inList}`,
      { headers });
    const tokenRows = tr.ok ? await tr.json() : [];
    if (tokenRows.length) {
      const byUser = {};
      tokenRows.forEach(t => { (byUser[t.user_id] = byUser[t.user_id] || []).push(t.token); });

      const dead = [];
      for (const row of list) {
        const tokens = byUser[row.recipient_id];
        if (!tokens || !tokens.length) continue;
        const w = wording(row.type, row.actor_username, row.preview);
        const out = await sendPush(tokens, {
          title: w.title,
          body: w.body,
          data: {
            type: row.type,
            post_id: row.post_id || '',
            actor_id: row.actor_id || ''
          }
        });
        pushed += out.sent;
        dead.push(...out.invalid);
      }
      // Drop tokens Apple says are dead, so they aren't retried forever.
      if (dead.length) {
        const dl = encodeURIComponent('(' + [...new Set(dead)].map(t => `"${t}"`).join(',') + ')');
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/device_tokens?token=in.${dl}`, { method: 'DELETE', headers });
        } catch (e) { /* they'll fail again next time, harmless */ }
      }
    }
  } catch (e) { console.error('push send error:', e); }

  return { inserted, pushed };
}
