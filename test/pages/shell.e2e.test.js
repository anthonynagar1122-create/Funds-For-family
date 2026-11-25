'use strict';
// Browser test of the app shell (router + responsive navigation) with a MOCKED Clerk and MOCKED API.
const { routeClerk } = require('../helpers/clerk-stub');
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

const CLERK_STUB = `window.Clerk = class { constructor(){ this.user = { id: 'mock' }; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} };`;

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

async function open(hash, { width = 1280, isAdmin = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await routeClerk(page, CLERK_STUB);
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user: { id: 9, name: 'Asha Rao', email: 'a@example.com', isAdmin } }));
  await page.route('**/api/feed', (route) => json(route, 200, { requests: [] }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.route('**/api/connections', (route) => json(route, 200, { following: [], followers: [], mutual: [] }));
  await page.route('**/api/activity', (route) => json(route, 200, { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { trustedContact: [], verifier: [] } }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  await page.waitForSelector('nav[aria-label="Primary"] a:visible');
  return { page, ctx };
}

const labels = (page) => page.locator('nav[aria-label="Primary"] a:visible').allInnerTexts().then((t) => t.map((s) => s.trim()));

test('desktop 1280px shows the recommended member nav at the top', { skip }, async () => {
  const { page, ctx } = await open('#/home');
  try {
    assert.deepEqual(await labels(page), ['Home', 'Discover', 'Activity', '+ New', 'Circle', 'Profile']);
    const box = await page.locator('nav[aria-label="Primary"]').boundingBox();
    assert.ok(box.y < 100, 'nav is at the top on desktop');
  } finally { await ctx.close(); }
});

test('phone 375px shows the recommended bottom tabs with targets of at least 44px', { skip }, async () => {
  const { page, ctx } = await open('#/home', { width: 375 });
  try {
    assert.deepEqual(await labels(page), ['Home', 'Discover', 'Activity', '+ New', 'Circle', 'Profile']);
    const nav = await page.locator('nav[aria-label="Primary"]').boundingBox();
    assert.ok(nav.y + nav.height >= 800 - 1 && nav.y > 400, 'nav is pinned to the bottom on phones');
    for (const a of await page.locator('nav[aria-label="Primary"] a:visible').all()) {
      const b = await a.boundingBox();
      assert.ok(b.height >= 44 && b.width >= 44, `target ${await a.innerText()} is ${b.width}x${b.height}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll at 375px');
  } finally { await ctx.close(); }
});

test('#/circle renders the circle page and marks Circle as current', { skip }, async () => {
  const { page, ctx } = await open('#/circle');
  try {
    await page.waitForSelector('#view-circle:not([hidden])');
    assert.equal(await page.locator('[aria-current="page"]').count(), 1);
    assert.equal((await page.locator('[aria-current="page"]').innerText()).trim(), 'Circle');
  } finally { await ctx.close(); }
});

test('an unknown hash renders home', { skip }, async () => {
  const { page, ctx } = await open('#/nonsense/here');
  try {
    await page.waitForSelector('#view-home:not([hidden])');
    assert.equal((await page.locator('[aria-current="page"]').innerText()).trim(), 'Home');
  } finally { await ctx.close(); }
});

test('navigating by tab updates the hash, the view and aria-current', { skip }, async () => {
  const { page, ctx } = await open('#/home');
  try {
    await page.getByRole('link', { name: 'Profile' }).click();
    await page.waitForSelector('#view-profile:not([hidden])');
    assert.match(await page.evaluate(() => location.hash), /profile/);
    assert.equal((await page.locator('[aria-current="page"]').innerText()).trim(), 'Profile');
    await page.getByRole('link', { name: '+ New' }).click();
    await page.waitForSelector('#view-new:not([hidden])');
    assert.equal((await page.locator('[aria-current="page"]').innerText()).trim(), '+ New');
  } finally { await ctx.close(); }
});

test('the old hashes still open their views', { skip }, async () => {
  const { page, ctx } = await open('#people');
  try {
    await page.waitForSelector('#view-circle:not([hidden])');
    assert.equal((await page.locator('[aria-current="page"]').innerText()).trim(), 'Circle');
  } finally { await ctx.close(); }
});

test('the restricted workspace is absent for members and role-labelled for admins and verifiers', { skip }, async () => {
  const member = await open('#/home', { isAdmin: false });
  try {
    assert.deepEqual(await labels(member.page), ['Home', 'Discover', 'Activity', '+ New', 'Circle', 'Profile']);
    await member.page.goto(`http://127.0.0.1:${server.address().port}/app/#/workspace`, { waitUntil: 'load' });
    await member.page.waitForSelector('#view-workspace:not([hidden])');
    assert.match(await member.page.locator('#workspace').innerText(), /do not have access/i);
  } finally { await member.ctx.close(); }

  const admin = await open('#/home', { isAdmin: true });
  try {
    assert.deepEqual(await labels(admin.page), ['Home', 'Discover', 'Activity', '+ New', 'Circle', 'Profile', 'Admin']);
  } finally { await admin.ctx.close(); }

  const verifierCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  try {
    const page = await verifierCtx.newPage();
    await routeClerk(page, CLERK_STUB);
    await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
    await page.route('**/api/me', (route) => json(route, 200, { user: { id: 11, name: 'Verifier', email: 'v@example.com', isAdmin: false, isVerifier: true } }));
    await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
    await page.goto(`http://127.0.0.1:${server.address().port}/app/#/home`, { waitUntil: 'load' });
    await page.waitForSelector('nav[aria-label="Primary"] a:visible');
    assert.deepEqual(await labels(page), ['Home', 'Discover', 'Activity', '+ New', 'Circle', 'Profile', 'Verify']);
  } finally { await verifierCtx.close(); }
});

test('window.Router, Api and Format are plain objects with the agreed functions', { skip }, async () => {
  const { page, ctx } = await open('#/home');
  try {
    const r = await page.evaluate(() => ({
      router: ['go', 'register'].map((k) => typeof window.Router[k]),
      api: ['get', 'post', 'patch', 'delete'].map((k) => typeof window.Api[k]),
      initials: window.Format.initials('Asha  rao'),
      one: window.Format.initials('Madonna'),
      avatar: window.Format.avatar({ name: '<img src=x onerror=1>' }),
    }));
    assert.deepEqual(r.router, ['function', 'function']);
    assert.deepEqual(r.api, ['function', 'function', 'function', 'function']);
    assert.equal(r.initials, 'AR');
    assert.equal(r.one, 'M');
    assert.doesNotMatch(r.avatar, /<img/);
  } finally { await ctx.close(); }
});

test('Api throws ApiError with status, code, field and message', { skip }, async () => {
  const { page, ctx } = await open('#/home');
  try {
    await page.route('**/api/boom', (route) => json(route, 422, { error: 'Too small', code: 'too_small', field: 'amount' }));
    const e = await page.evaluate(async () => {
      try { await window.Api.post('/boom', { a: 1 }); return null; }
      catch (err) { return { name: err.name, isApiError: err instanceof window.ApiError, status: err.status, code: err.code, field: err.field, message: err.message }; }
    });
    assert.deepEqual(e, { name: 'ApiError', isApiError: true, status: 422, code: 'too_small', field: 'amount', message: 'Too small' });
  } finally { await ctx.close(); }
});
