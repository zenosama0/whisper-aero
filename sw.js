const CACHE = 'whisper-shell-v21';
const FILES = [
  './',
  './index.html',
  './styles.css?v=21',
  './auth.css?v=21',
  './overrides.css?v=21',
  './app.js?v=21',
  './app-config.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './js/config.js',
  './js/emoji.js?v=21',
  './js/native.js?v=21',
  './js/utils.js',
  './js/state.js',
  './js/api.js',
  './js/realtime.js',
  './js/viewOnce.js',
  './js/ui/chat.js',
  './js/ui/modals.js',
  './js/main.js?v=21',
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
  if (url.pathname.endsWith('/version.json')) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
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

  const conversationId = data.conversationId || '';
  const tag = data.tag || (conversationId ? `whisper-msg-${conversationId}` : 'whisper');
  const nextLine = String(data.body || 'You have a new notification.');

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = windowClients.some(
      (client) => client.visibilityState === 'visible' || client.focused,
    );
    if (hasVisibleClient) return;

    const existing = await self.registration.getNotifications({ tag }).catch(() => []);
    let lines = [];
    if (existing.length) {
      const prev = existing[0];
      const prevLines = Array.isArray(prev.data?.lines)
        ? prev.data.lines
        : (prev.body ? prev.body.split('\n') : []);
      lines = [...prevLines, nextLine].slice(-6);
    } else {
      lines = [nextLine];
    }

    const targetUrl = data.url || (conversationId ? `./?chat=${conversationId}` : './');
    await self.registration.showNotification(data.title || 'Whisper', {
      body: lines.join('\n'),
      icon: data.icon || './icon-192.png',
      badge: './icon-192.png',
      tag,
      renotify: true,
      vibrate: data.vibrate || [120],
      data: {
        url: targetUrl,
        conversationId,
        lines,
      },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const baseScope = self.registration.scope;
  const rawUrl = event.notification.data?.url || './';
  const target = new URL(rawUrl, baseScope).href;
  const conversationId = event.notification.data?.conversationId || '';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => c.url.startsWith(baseScope));
      if (client) {
        if (conversationId) {
          client.postMessage({ type: 'OPEN_CHAT', conversationId });
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
