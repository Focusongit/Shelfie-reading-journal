/* Shelfie service worker: makes the app open and work offline.
 *
 * Bump VERSION every time you deploy a change to index.html (or any cached file).
 * That makes browsers install the new copy and show the "update ready" toast.
 *
 * Caching rules
 *  - App files (index.html, manifest, icons): precached on install, served instantly
 *    from cache, quietly refreshed in the background when online.
 *  - Google Fonts: cached the first time they load, then work offline.
 *  - Book search / cover APIs and any other site: NOT touched. They need internet
 *    and fail normally when offline (the app already shows its "you're offline" message).
 *  - Your library lives in IndexedDB, not here, so updating or clearing these
 *    caches never touches your books.
 */
const VERSION = 'v1';
const APP_CACHE = `shelfie-app-${VERSION}`;
const FONT_CACHE = 'shelfie-fonts-v1';

const PRECACHE = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      // cache:'reload' skips the browser's HTTP cache so we never precache a stale file
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('shelfie-app-') && k !== APP_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(event, cacheName, fetchInit) {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request, fetchInit)
    .then((res) => {
      if (cacheable(res)) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) || Response.error();
}

// Shelfie is a single page, so every navigation gets index.html.
async function openApp(event) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match('./index.html');
  const refresh = fetch('./index.html', { cache: 'no-cache' })
    .then((res) => {
      if (res.ok) cache.put('./index.html', res.clone());
      return res;
    });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  try {
    return await refresh;
  } catch (_) {
    return new Response('Shelfie is offline and has not been saved on this device yet. Open it once while online.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
    return;
  }
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return; // other sites: leave to the network

  if (request.mode === 'navigate') {
    event.respondWith(openApp(event));
    return;
  }
  event.respondWith(staleWhileRevalidate(event, APP_CACHE, { cache: 'no-cache' }));
});
