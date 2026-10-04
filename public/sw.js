const CACHE = 'kgn-offerte-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/fonts/fonts.css', '/fonts/schibsted-latin.woff2', '/fonts/schibsted-latin-ext.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|o|files)\//.test(u.pathname)) return;
  const key = u.pathname === '/' ? '/' : e.request;
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; })
      .catch(() => caches.match(key).then(r => r || caches.match('/')))
  );
});

/* ---------- Meldingen ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'KGN Offerte', {
    body: d.body || '', tag: d.tag || undefined, data: { url: d.url || '/' },
    icon: '/icons/icon-192.png', badge: '/icons/favicon-32.png'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) return c.focus().then(w => (w && 'navigate' in w) ? w.navigate(url) : w).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  }));
});
