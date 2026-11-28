'use strict';
// Service worker for the /app/ shell. Policy (keep narrow):
//  - GET only. POST/PATCH/PUT/DELETE are never touched.
//  - Shell files: cache-first.
//  - API: network-first with last-saved fallback, ONLY for the allow-list below.
//  - Never cached: /api/admin*, /api/invites*, any request carrying an invite token, any other API path.
// Bump CACHE_VERSION on each release; older caches are deleted on activate.
const CACHE_VERSION = 'ff-v13'; // ff-v13: request page withdraw, close early, pick another contact, Try again, Fix and Delete (G-02, G-03)
const SHELL_FILES = [
  '/app/', '/app/index.html', '/styles.css', '/app.js',
  '/app/money.js', '/app/format.js', '/app/api.js', '/app/nav.js', '/app/card-model.js',
  '/app/pages/welcome.js', '/app/pages/home.js', '/app/pages/new-request.js', '/app/pages/request.js', '/app/pages/circle.js', '/app/pages/profile.js', '/app/pages/admin.js', '/app/pages/legal.js', '/vendor/qr.js',
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

// Shared-device privacy: every saved API answer remembers whose it is. The page sends the signed-in member's id
// in x-ff-user (the last id it saw from a live /api/me). An answer is served offline only to that same member.
// /api/me names its owner in the body; the other saved paths take the id the request carried when it was saved.
const OWNER_HEADER = 'x-ff-saved-for';
const WHO_HEADER = 'x-ff-user';

async function ownerOf(req, res, key) {
  if (key === '/api/me') {
    try { const body = await res.clone().json(); return body && body.user && body.user.id != null ? String(body.user.id) : ''; } catch { return ''; }
  }
  return req.headers.get(WHO_HEADER) || '';
}

async function savedCopy(res, owner) {
  const headers = new Headers(res.headers);
  headers.set(OWNER_HEADER, owner);
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
}

function signInAgain() {
  return new Response(JSON.stringify({ error: 'Sign in again to see your saved view', code: 'saved_view_mismatch' }),
    { status: 401, headers: { 'content-type': 'application/json' } });
}

async function apiNetworkFirst(req, key) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await fetch(req);
    // Only successful, non-private-marked responses are saved.
    if (res.ok && !/no-store|private/i.test(res.headers.get('cache-control') || '')) await cache.put(key, await savedCopy(res, await ownerOf(req, res, key)));
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    const who = req.headers.get(WHO_HEADER) || '';
    if (!who || hit.headers.get(OWNER_HEADER) !== who) return signInAgain();
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
