/**
 * Offline support for the Home Screen web app (docs/hosting.md).
 *
 * **Network first, cache as the fallback — never the other way round.** Cache-first is faster and
 * would serve yesterday's build until something evicts it, which on an app changing daily means a
 * phone quietly running old code while its owner reports bugs against the new. Here every request
 * goes to the network, the answer refreshes the cache, and the cache is only read when the network
 * fails or stalls. The cost is load speed on a bad connection, bounded by `NETWORK_TIMEOUT_MS`.
 *
 * **Plain JS beside `ui/index.html`, not in `ui/src`.** A service worker is loaded by URL into its own
 * scope, like the capture worklet, and its scope is its own folder — `ui/` — which is where the page
 * lives. Requests for `../docs/kit/…` are still intercepted: scope decides which *pages* are
 * controlled, not which URLs.
 *
 * **Nothing about projects or takes is here.** Those live in IndexedDB, which a service worker neither
 * reads nor caches; this file only makes the *app* open without a connection.
 */

const CACHE = 'loops-shell-v1';
const NETWORK_TIMEOUT_MS = 4000;

/**
 * Fetched at install so the first offline launch works even for files the first online session never
 * requested — the worklet above all, which loads only when a row is first armed. The module graph
 * under `dist/` is cached as the app imports it, which a boot always does in full.
 */
const PRECACHE = [
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './worklets/capture.js',
  './dist/ui/src/app.js',
  '../docs/kit/lr-kit.css',
  '../docs/kit/lr-kit.js',
];

/** Same origin, plus Google Fonts, whose stylesheet and font files both have to work offline. */
function cacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return (
    url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // One at a time and tolerant: a single missing file must not leave the app with no cache.
      Promise.all(PRECACHE.map((path) => cache.add(path).catch(() => undefined))),
    ),
  );
  // Network-first means a new worker serves the same answers the old one would, so there is no
  // version skew to protect against by waiting.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (!cacheable(event.request)) return;
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      // `no-cache`: revalidate with the server every time rather than trust the browser's HTTP
      // cache. GitHub Pages sends `max-age=600`, so a plain fetch served a pushed build's old files
      // for up to ten minutes — reported as "I don't see the update on the live link". An
      // unchanged file costs a 304 and no body.
      fetch(request, { cache: 'no-cache' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    // `opaque` is a cross-origin font response; it cannot be inspected but it can be replayed.
    if (response.ok || response.type === 'opaque') void cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    throw error;
  }
}
