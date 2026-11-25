'use strict';
// Browser test of the Content-Security-Policy in vercel.json. It serves public/ with the same header
// production sends, then checks (1) the app's own scripts and styles load with no violations, and
// (2) an injected inline script is blocked, which proves the policy is enforced.
// Clerk's script is stubbed here, because this environment cannot reach Clerk's servers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.txt': 'text/plain' };
const CSP = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
  .headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const CLERK_URL = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js';
const CLERK_STUB = `window.Clerk = class { constructor(){ this.user = null; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} };`;

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';
let server = null;
let browser = null;

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function openPage() {
  const page = await browser.newPage();
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => { if (/Content Security Policy/i.test(e.message)) violations.push(e.message); });
  // Clerk's script comes from the CDN; serve the stub in its place (the CDN itself is allowed by the policy).
  await page.route(CLERK_URL, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: CLERK_STUB }));
  // The config call is not part of this check; answer it so boot() completes.
  await page.route('**/api/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"clerkPublishableKey":null}' }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  return { page, violations };
}

test('the policy is sent and forbids scripts from anywhere but the allowed hosts', () => {
  const directive = (name) => CSP.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' '));
  assert.ok(directive('default-src')?.includes("'self'"));
  assert.doesNotMatch(directive('script-src'), /unsafe-inline|unsafe-eval/, 'no inline or eval scripts');
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('the app loads its own scripts and styles with no policy violations', { skip }, async () => {
  const { page, violations } = await openPage();
  try {
    assert.equal(await page.locator('#view-home, #signed-out').count() > 0, true, 'the app shell rendered');
    assert.deepEqual(violations, [], 'no violations for the app\'s own assets');
  } finally { await page.context().close(); }
});

test('the policy is enforced: an injected inline script is blocked', { skip }, async () => {
  const { page, violations } = await openPage();
  try {
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__ran = true';
      document.head.appendChild(s);
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__ran === true), false, 'inline script did not run');
    assert.ok(violations.some((v) => /script-src/.test(v)), 'the browser reported a script-src violation');
  } finally { await page.context().close(); }
});
