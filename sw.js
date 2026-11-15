/* Shelfie service worker: makes the app open and work offline.
 *
 * Deploying an update: just push your new index.html. The next time someone opens the
 * app online, this worker notices the change and the app shows its "Update" bar.
 * Bump VERSION below only when you change THIS file, the manifest or the icons
 * (anything in PRECACHE), so those get re-downloaded too.
 *
 * What is cached
 *  - App files (index.html, manifest, icons): saved on install, served instantly from
 *    cache, quietly checked for changes in the background when online.
 *  - Remote book covers (<img> only): saved the first time they appear, so they still show
 *    offline. Capped at MAX_COVERS, oldest dropped first.
 *  - Book search / AniList / Google Books APIs: never touched; they need internet.
 *  - Your library lives in IndexedDB, not in these caches, so updating or clearing
 *    them never touches your books.
 */
const VERSION = 'v2';
const APP_CACHE = `shelfie-app-${VERSION}`;
const COVER_CACHE = 'shelfie-covers-v1';
const MAX_COVERS = 80;

const PRECACHE = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The app listens for this message and shows its "A new version of Shelfie is ready" bar.
async function tellClients(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach((c) => c.postMessage(msg));
}

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
    (async () => {
      const keys = await caches.keys();
      const oldApp = keys.filter((k) => k.startsWith('shelfie-app-') && k !== APP_CACHE);
      const stale = keys.filter((k) => k.startsWith('shelfie-') && k !== APP_CACHE && k !== COVER_CACHE);
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (oldApp.length) await tellClients({ type: 'update-available' }); // an upgrade, not a first install
    })()
  );
});

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

async function staleWhileRevalidate(event, cacheName) {
  const request = event.request;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request, { cache: 'no-cache' })
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
  const refresh = (async () => {
    const res = await fetch('./index.html', { cache: 'no-cache' });
    if (!res.ok) return res;
    // read a fresh copy of the cached page: the one returned to the browser is already being consumed
    const cached = hit && (await cache.match('./index.html'));
    if (!cached) {
      await cache.put('./index.html', res.clone());
    } else {
      const [before, after] = await Promise.all([cached.text(), res.clone().text()]);
      if (before !== after) {
        await cache.put('./index.html', res.clone());
        await wait(1500); // let the page that was just opened finish loading before we tell it
        await tellClients({ type: 'update-available' });
      }
    }
    return res;
  })();
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

async function trim(cache, max) {
  const keys = await cache.keys(); // oldest first
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

// Remote cover images: cache-first. Try a CORS request first (stored at true size);
// fall back to a plain image request (stored as an opaque response) for hosts without CORS.
async function coverImage(event) {
  const request = event.request;
  const cache = await caches.open(COVER_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  } catch (_) {
    res = await fetch(request); // throws when offline; the image then simply fails to load
  }
  if (cacheable(res)) {
    event.waitUntil(cache.put(request, res.clone()).then(() => trim(cache, MAX_COVERS)));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') event.respondWith(openApp(event));
    else event.respondWith(staleWhileRevalidate(event, APP_CACHE));
    return;
  }
  if (request.destination === 'image') {
    event.respondWith(coverImage(event));
    return;
  }
  // everything else (search APIs etc.) goes straight to the network
});
