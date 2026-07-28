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
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'rxhive',
    renotify: true,
    // convId is carried separately from the url so notificationclick can tell a
    // focused tab WHICH conversation to open, which a url alone cannot do.
    data: { url: payload.url || '/chat', convId: payload.conversation_id || null },
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
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
