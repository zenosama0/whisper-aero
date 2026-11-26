const CACHE = 'whisper-shell-v11';
const FILES = [
  './',
  './index.html',
  './styles.css?v=11',
  './auth.css?v=11',
  './overrides.css?v=11',
  './app.js?v=11',
  './app-config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './js/config.js',
  './js/utils.js',
  './js/state.js',
  './js/api.js',
  './js/realtime.js',
  './js/viewOnce.js',
  './js/ui/chat.js',
  './js/ui/modals.js',
  './js/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('whisper-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Whisper', {
      body: data.body || 'You have a new notification.',
      icon: './icon.svg',
      badge: './icon.svg',
      tag: data.tag || 'whisper',
      renotify: true,
      vibrate: data.vibrate || [120],
      data: { url: data.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => new URL(c.url).origin === self.location.origin);
      return client ? (client.navigate(target), client.focus()) : self.clients.openWindow(target);
    }),
  );
});
