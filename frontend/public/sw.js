/* RX HIVE service worker — offline shell + Web Push. */
const CACHE = 'rxhive-shell-v1';
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
    data: { url: payload.url || '/chat' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/chat';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes(target) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
