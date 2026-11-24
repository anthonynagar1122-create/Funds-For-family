'use strict';
// Installable app + offline shell. Real HTTP server with canned API responses (page.route cannot see
// requests that a service worker handles), mocked Clerk script.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';
let server = null;
let browser = null;
let base = '';
const apiHits = [];
const dropPaths = new Set(); // API paths whose connection is cut, to stand in for "offline" on one endpoint

const CLERK_STUB = `window.Clerk = class { constructor(){ this.user = { id: 'mock' }; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} };`;

const API = {
  '/api/config': { clerkPublishableKey: 'pk_test_mock' },
  '/api/me': { user: { id: 9, name: 'Asha Rao', email: 'a@example.com', isAdmin: false } },
  '/api/feed': { requests: [] },
  '/api/home': {},
  '/api/connections': { following: [], followers: [], mutual: [] },
  '/api/activity': { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { trustedContact: [], verifier: [] } },
};

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    let rel = req.url.split('?')[0];
    if (rel.startsWith('/api/')) {
      apiHits.push(`${req.method} ${rel}`);
      if (dropPaths.has(rel)) return req.destroy();
      const body = API[rel];
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body || {}));
    }
    if (rel === '/app/' || rel === '/app') rel = '/app/index.html';
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('manifest has the install fields and both icons exist', { skip }, async () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Funds For Family');
  assert.equal(m.short_name, 'Funds');
  assert.equal(m.start_url, '/app/');
  assert.equal(m.scope, '/app/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#1f6f5c');
  assert.equal(m.background_color, '#f6f7f5');
  for (const size of ['192x192', '512x512']) {
    const icon = m.icons.find((i) => i.sizes === size);
    assert.ok(icon, `icon ${size}`);
    assert.equal(icon.type, 'image/png');
    const buf = fs.readFileSync(path.join(PUBLIC, icon.src));
    assert.equal(buf.readUInt32BE(16), Number(size.split('x')[0]), 'PNG width matches');
  }
});

test('/app/ links the manifest; the landing page does not', { skip }, async () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app', 'index.html'), 'utf8');
  assert.match(app, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(app, /serviceWorker/);
  const landing = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(landing, /manifest|serviceWorker/);
});

test('offline: /app/ still renders from the shell cache and shows the offline note', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  try {
    await page.goto(`${base}/app/#/home`, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' }); // now controlled by the SW; API responses get saved
    await page.waitForSelector('nav[aria-label="Primary"] a:visible');
    assert.equal(await page.locator('#offline-note').isHidden(), true, 'no offline note while online');

    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav[aria-label="Primary"] a:visible');
    const note = page.locator('#offline-note');
    await note.waitFor({ state: 'visible' });
    assert.match(await note.innerText(), /You're offline, showing your last saved view/);
    assert.equal(await page.evaluate(() => window.Api.fromCache), true);
  } finally { await ctx.close(); }
});

test('service worker saved nothing for mutations or admin paths', { skip }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  try {
    await page.goto(`${base}/app/#/home`, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('nav[aria-label="Primary"] a:visible'); // boot has fetched /api/me and /api/feed
    await page.evaluate(async () => {
      await fetch('/api/admin/users').catch(() => {});
      await fetch('/api/feed', { method: 'POST', body: '{}' }).catch(() => {});
      await fetch('/api/invites').catch(() => {});
      await fetch('/api/me', { headers: { 'x-invite-token': 'secret-tok' } }).catch(() => {});
    });
    const saved = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(`${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`);
      return out;
    });
    assert.ok(saved.some((s) => s === 'GET /api/home'), 'allow-listed GET saved');
    for (const s of saved) {
      assert.ok(s.startsWith('GET '), s);
      assert.ok(!/\/api\/(admin|invites)/.test(s), s);
    }
    assert.equal(saved.filter((s) => s === 'GET /api/me').length <= 1, true);
  } finally { await ctx.close(); }
});

test('shared device: member B offline never sees what the service worker saved for member A', { skip }, async () => {
  const A = { id: 9, name: 'Asha Rao', email: 'a@example.com', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  const B = { id: 10, name: 'Bela Das', email: 'b@example.com', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  const homeA = { needsYou: [], myLending: [], myRequests: [{ id: 77, purpose: 'ASHA-PRIVATE school fees', status: 'open', principalCents: 500000, totals: { confirmedCents: 0, pendingCents: 0 } }] };
  const saveAPI = { me: API['/api/me'], home: API['/api/home'] };
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  try {
    // A signs in online; the service worker saves A's home.
    API['/api/me'] = { user: A };
    API['/api/home'] = homeA;
    await page.goto(`${base}/app/#/home`, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#my-requests');
    assert.match(await page.locator('#home').innerText(), /ASHA-PRIVATE/);

    // B signs in on the same browser (A did not sign out through the app). B's home cannot be reached.
    API['/api/me'] = { user: B };
    API['/api/home'] = { needsYou: [], myLending: [], myRequests: [] };
    dropPaths.add('/api/home');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => /Sign in again/.test(document.getElementById('home').innerText));
    assert.doesNotMatch(await page.locator('body').innerText(), /ASHA-PRIVATE/);

    // Fully offline as B: still no A data, only the message.
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /Sign in again to see your saved view/.test(document.getElementById('home').innerText));
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /ASHA-PRIVATE|Asha/);
    const savedHome = await page.evaluate(async () => {
      for (const k of await caches.keys()) { const r = await (await caches.open(k)).match('/api/home'); if (r) return r.headers.get('x-ff-saved-for'); }
      return null;
    });
    assert.equal(savedHome, '9', 'the saved copy is tagged with its owner');
  } finally {
    dropPaths.clear();
    API['/api/me'] = saveAPI.me; API['/api/home'] = saveAPI.home;
    await ctx.close();
  }
});

test('sign-out clears saved answers and the remembered member id', { skip }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  try {
    await page.goto(`${base}/app/#/home`, { waitUntil: 'load' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('nav[aria-label="Primary"] a:visible');
    assert.equal(await page.evaluate(() => localStorage.getItem('ff-user')), '9');
    await page.evaluate(() => window.Api.clearSaved());
    assert.equal(await page.evaluate(() => localStorage.getItem('ff-user')), null);
    const left = await page.evaluate(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith('/api/')) out.push(r.url);
      return out;
    });
    assert.deepEqual(left, []);
  } finally { await ctx.close(); }
});
