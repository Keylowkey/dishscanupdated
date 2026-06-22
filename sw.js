// sw.js — KILL SWITCH.
// A previous service worker was intercepting and breaking network requests
// ("Failed to fetch"). This replacement does the opposite: it removes itself,
// clears all caches, and never intercepts any request. Deploy it to neutralize
// any stale service worker still installed on users' devices.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => client.navigate(client.url));
    } catch (e) {}
  })());
  self.clients.claim();
});

// No 'fetch' listener — every request goes straight to the network.
