'use strict';
// Terms and Privacy pages: static, inside the app shell, readable without signing in. MOCKED Clerk and API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';
let server = null;
let browser = null;

const clerkStub = (signedIn) => `window.Clerk = class { constructor(){ this.user = ${signedIn ? "{ id: 'mock' }" : 'null'}; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} async signOut(){} };`;

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    let rel = req.url.split('?')[0];
    if (rel === '/app/' || rel === '/app') rel = '/app/index.html';
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function open(hash, { signedIn = true, welcomed = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const stamp = welcomed ? '2026-11-20T12:00:00.000Z' : null;
  const user = { id: 9, name: 'Asha Rao', email: 'asha@example.com', upiId: null, avatarUrl: null, isAdmin: false, welcomedAt: stamp, termsAcceptedAt: stamp, inviterName: null };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: clerkStub(signedIn) }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/users/9', (route) => json(route, 200, { user: { id: 9, name: 'Asha Rao', trust: null } }));
  await page.route('**/api/help/mine', (route) => json(route, 200, { messages: [] }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  return { page, ctx };
}

for (const [route, heading, must] of [
  ['terms', 'Terms of use', [/draft/i, /lawyer/i, /no money moves through the app/i, /trusted contact is not a guarantor/i, /no obligation to repay/i, /Profile.{1,6}Delete account/i, /no interest/i]],
  ['privacy', 'Privacy notice', [/draft/i, /lawyer/i, /who can see what/i, /how long/i, /Profile.{1,6}Delete account/i]],
]) {
  for (const signedIn of [true, false]) {
    test(`#/${route} renders for a ${signedIn ? 'signed-in member' : 'visitor who is not signed in'}`, { skip }, async () => {
      const { page, ctx } = await open(`#/${route}`, { signedIn });
      try {
        await page.waitForSelector('#view-legal:not([hidden]) h1');
        assert.equal(await page.locator('h1:visible').count(), 1, 'one visible h1');
        assert.equal((await page.locator('#view-legal h1').innerText()).trim(), heading);
        const text = await page.locator('#view-legal').innerText();
        for (const re of must) assert.match(text, re);
        // The only place "interest" may appear is "no interest".
        assert.doesNotMatch(text.replace(/no interest/gi, ''), /interest/i);
        assert.doesNotMatch(text, /nominee/i);
        assert.equal(await page.locator('#signed-out').isHidden(), true);
      } finally { await ctx.close(); }
    });
  }
}

test('the welcome terms checkbox links to #/terms and #/privacy', { skip }, async () => {
  const { page, ctx } = await open('#/home', { welcomed: false });
  try {
    await page.waitForSelector('#w-terms');
    assert.equal(await page.locator('label[for="w-terms"] a[href="#/terms"]').count(), 1);
    assert.equal(await page.locator('label[for="w-terms"] a[href="#/privacy"]').count(), 1);
    await page.locator('label[for="w-terms"] a[href="#/terms"]').click();
    await page.waitForSelector('#view-legal:not([hidden]) h1');
    assert.equal((await page.locator('#view-legal h1').innerText()).trim(), 'Terms of use');
  } finally { await ctx.close(); }
});

test('the profile page links to #/terms and #/privacy', { skip }, async () => {
  const { page, ctx } = await open('#/profile');
  try {
    await page.waitForSelector('#view-profile:not([hidden]) h1');
    assert.equal(await page.locator('#view-profile a[href="#/privacy"]').count(), 1);
    assert.equal(await page.locator('#view-profile a[href="#/terms"]').count(), 1);
    await page.locator('#view-profile a[href="#/privacy"]').click();
    await page.waitForSelector('#view-legal:not([hidden]) h1');
    assert.equal((await page.locator('#view-legal h1').innerText()).trim(), 'Privacy notice');
  } finally { await ctx.close(); }
});
