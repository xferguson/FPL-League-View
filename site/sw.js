// Caches the app shell (this file's own siblings) so the page opens with no
// network at all — the point of installing it to a homescreen. The stats file
// is deliberately left alone: app.js does its own fetch + localStorage
// fallback for that, so it can tell fresh data from a stale offline copy and
// say so. Bump VERSION on a shell change to evict the old cache — this file's
// own bytes changing is also what makes the browser notice there's an update
// at all, so a change here can't be silently skipped by editing SHELL alone.
const VERSION = 'v2';
const CACHE = `fpl-league-view-${VERSION}`;

// Relative to this file's own location (the site root), so this works the
// same whether the site is served from a domain root or a GitHub Pages
// subpath — nothing here hardcodes the repo name.
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './vendor/chart.umd.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Let the league data hit the network untouched — see the header comment.
  if (url.pathname.endsWith('/data/league.json')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      // Cache-first for an instant offline load, refreshed in the background
      // so a shell update is picked up on the next launch without a version
      // bump being the only way to invalidate it.
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((cache) => cache.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
