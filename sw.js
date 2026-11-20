const CACHE = 'vocabnotes-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first for API calls, cache-first for assets
  if (
    e.request.url.includes('api.groq.com') ||
    e.request.url.includes('api.airtable.com') ||
    e.request.url.includes('fonts.g')
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push Notifications ───────────────────────────────────────

self.addEventListener('push', (e) => {
  // Attempt to parse JSON payload; if it fails, treat raw text as title.
  let data = {};
  if (e.data) {
    try {
      data = e.data.json();
    } catch (_) {
      // Fallback: handle raw text payload which may be synchronous or a Promise.
      const maybe = e.data.text();
      if (maybe && typeof maybe.then === 'function') {
        // Asynchronous – wait for the promise.
        return e.waitUntil(
          maybe.then(txt => {
            self.registration.showNotification(txt, {
              body: "Time to review today's word!",
              icon: './icons/icon-192.png',
              badge: './icons/icon-192.png',
              tag: 'vocabnotes-daily',
              renotify: true,
              data: { url: './' },
            });
          })
        );
      } else {
        // Synchronous string.
        const txt = maybe || '';
        return e.waitUntil(
          self.registration.showNotification(txt, {
            body: "Time to review today's word!",
            icon: './icons/icon-192.png',
            badge: './icons/icon-192.png',
            tag: 'vocabnotes-daily',
            renotify: true,
            data: { url: './' },
          })
        );
      }
    }
  }
  const title = data.title || '📚 VocabNotes';
  const body = data.body || "Time to review today's word!";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'vocabnotes-daily',
      renotify: true,
      data: { url: './' }
    })
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
