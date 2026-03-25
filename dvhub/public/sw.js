// DVhub Service Worker — caches UI shell, API calls always go to network
const CACHE_NAME = 'dvhub-v1';
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/common.js',
  '/app.js',
  '/history.js',
  '/setup.js',
  '/tools.js',
  '/manifest.json',
  '/assets/logo-192.png',
  '/assets/logo-512.png',
  '/assets/favicon-32.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls and DV endpoints always go to network (live data)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
    return;
  }

  // External resources (fonts, CDN scripts) — network first, cache fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // UI shell — stale-while-revalidate (serve cached, update in background)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
