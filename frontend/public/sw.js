/* RX HIVE service worker — offline shell + Web Push. */
// Bumped whenever this file changes: the activate handler below deletes every
// cache whose key is not this one, so a new name is what makes clients adopt the
// new push/notificationclick handlers instead of keeping the old shell.
const CACHE = 'rxhive-shell-v2';
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache API or media — always hit the network.
  if (url.pathname.startsWith('/api')) return;
  // App shell: network-first for navigations, cache fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Static assets: cache-first.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((resp) => {
      if (resp.ok && (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname))) {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return resp;
    }))
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'RX HIVE', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'RX HIVE';
  // An incoming CALL, not a message. This is the only channel that reaches a client
  // whose WebSocket is gone — the `call:incoming` frame is published to a channel
  // with no subscriber and evaporates — so it is the difference between a ring the
  // user can answer and a missed call they never knew about.
  const isCall = payload.kind === 'call';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'rxhive',
    renotify: true,
    // Stays on screen until acted on, and vibrates like a ring rather than a ping.
    // A call notification that auto-dismisses after a few seconds is worse than
    // none: the ring window is 45 seconds and the user has to be able to find it.
    requireInteraction: isCall,
    vibrate: isCall ? [400, 200, 400, 200, 400] : undefined,
    // convId is carried separately from the url so notificationclick can tell a
    // focused tab WHICH conversation to open, which a url alone cannot do. callId
    // does the same job for a ring: the page fetches GET /api/calls/active on
    // focus, so this is a hint for logging rather than the mechanism.
    data: {
      url: payload.url || '/chat',
      convId: payload.conversation_id || null,
      callId: payload.call_id || null,
      isCall,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || '/chat';
  const convId = data.convId || null;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Match on ORIGIN, not on the full url. The previous `c.url.includes(target)`
      // test could not match once target carried a `?c=<id>` query — a tab sitting
      // on /chat does not contain that string — so every click opened yet another
      // window instead of focusing the app the user already had open. Same reason
      // a tab on /settings was never matched.
      const origin = self.location.origin;
      const existing = clients.find((c) => c.url.startsWith(origin) && 'focus' in c);
      if (existing) {
        // Tell the page which conversation to select; a focus() alone leaves the
        // user looking at whatever they had open.
        if (convId && 'postMessage' in existing) {
          existing.postMessage({ type: 'rxhive:open-conversation', convId });
        }
        if (data.isCall && 'postMessage' in existing) {
          // Nudge the page to reconcile with the server immediately rather than
          // waiting for its next reconnect. Focusing already triggers the
          // visibilitychange wake in services/websocket.js, so this is the belt to
          // that braces — the ring is recovered from GET /api/calls/active either way.
          existing.postMessage({ type: 'rxhive:incoming-call', callId: data.callId || null });
        }
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
