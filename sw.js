const CACHE = 'worldcards-cache-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './countries.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        if (res.ok && res.url.startsWith(self.location.origin)) {
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
