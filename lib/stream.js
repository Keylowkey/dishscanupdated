// lib/stream.js — turn an Anthropic completion into a live stream for the app.
//
// A recipe takes 12–17 seconds to generate. Sending it in one piece means the
// user stares at a spinner for the whole time and then everything appears at
// once. The model emits the JSON in a useful order — dish name first, then the
// summary fields, then the long arrays — so forwarding tokens as they arrive
// lets the title show up in about a second and the rest fill in behind it.
//
// Server-Sent Events, one JSON object per event:
//   { t: "..." }                    a chunk of raw model output
//   { done: true, recipe: {...} }   the parsed result
//   { error: "..." }                something went wrong
//
// This is opt-in. Callers that do not ask for a stream get the original
// single-response JSON, so the builds already on the App Store are unaffected.

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

/** Strip markdown fences and anything either side of the JSON object. */
export function extractJson(text) {
  let clean = String(text || '').replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s !== -1 && e !== -1) clean = clean.substring(s, e + 1);
  return clean;
}

/**
 * Run a streaming completion, forwarding text deltas to the client as they
 * arrive, and finish with the fully parsed object.
 *
 * @returns {Promise<void>} resolves once the response has been ended.
 */
export async function streamCompletion(res, { key, model, maxTokens, temperature, prompt }) {
  // no-transform matters: without it a proxy may buffer the whole response and
  // undo the point of streaming.
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* client hung up */ }
  };

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature, stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
      })
    });
  } catch (e) {
    send({ error: 'Could not reach the recipe service.' });
    return res.end();
  }

  if (!upstream.ok || !upstream.body) {
    send({ error: 'AI error ' + upstream.status });
    return res.end();
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';    // unparsed SSE from Anthropic
  let full = '';      // the model's text, accumulated

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Anthropic sends SSE too; pull out complete events and forward the text.
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = raw.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
          full += evt.delta.text;
          send({ t: evt.delta.text });
        } else if (evt.type === 'error') {
          send({ error: (evt.error && evt.error.message) || 'AI error' });
        }
      }
    }
  } catch (e) {
    send({ error: 'The connection dropped while generating.' });
    return res.end();
  }

  // Hand back the parsed object so the client never has to trust its own
  // partial parsing for the final state.
  try {
    send({ done: true, recipe: JSON.parse(extractJson(full)) });
  } catch (e) {
    send({ error: 'Could not parse recipe.' });
  }
  res.end();
}
