'use strict';
// Service worker for the /app/ shell. Policy (keep narrow):
//  - GET only. POST/PATCH/PUT/DELETE are never touched.
//  - Shell files: cache-first.
//  - API: network-first with last-saved fallback, ONLY for the allow-list below.
//  - Never cached: /api/admin*, /api/invites*, any request carrying an invite token, any other API path.
// Bump CACHE_VERSION on each release; older caches are deleted on activate.
const CACHE_VERSION = 'ff-v5';
const SHELL_FILES = [
  '/app/', '/app/index.html', '/styles.css', '/app.js',
  '/app/money.js', '/app/format.js', '/app/api.js', '/app/nav.js', '/app/card-model.js',
  '/app/pages/welcome.js', '/app/pages/home.js', '/app/pages/new-request.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest',
];
const API_ALLOW = ['/api/home', '/api/feed', '/api/me', '/api/activity'];
const API_DENY_PREFIXES = ['/api/admin', '/api/invites'];
const TOKEN_HEADERS = ['x-invite-token'];

function shouldHandle(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    if (API_DENY_PREFIXES.some((d) => p === d || p.startsWith(d + '/'))) return null;
    if (TOKEN_HEADERS.some((h) => request.headers.has(h))) return null;
    if (url.search || !API_ALLOW.includes(p)) return null;
    return { kind: 'api', key: p };
  }
  if (p === '/app' || p === '/app/') return { kind: 'shell', key: '/app/' };
  if (SHELL_FILES.includes(p)) return { kind: 'shell', key: p };
  return null;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE_VERSION) await caches.delete(k);
    // No clients.claim(): the page that registered this worker keeps loading straight from the network.
    // Taking it over mid-boot made its first /api calls race between the network and the worker.
    // The worker controls the next load, which is the one that needs the saved copies.
  })());
});

async function shellFirst(req, key) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(key, res.clone());
  return res;
}

async function apiNetworkFirst(req, key) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await fetch(req);
    // Only successful, non-private-marked responses are saved.
    if (res.ok && !/no-store|private/i.test(res.headers.get('cache-control') || '')) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    const headers = new Headers(hit.headers);
    headers.set('x-from-sw-cache', '1');
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const h = shouldHandle(event.request);
  if (!h) return;
  event.respondWith(h.kind === 'shell' ? shellFirst(event.request, h.key) : apiNetworkFirst(event.request, h.key));
});
