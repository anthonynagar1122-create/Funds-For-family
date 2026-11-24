'use strict';
// Browser test of the welcome flow with a MOCKED Clerk and MOCKED API.
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

async function open({ inviterName = null, welcomedAt = null, termsAcceptedAt = null, name = '<b>Asha</b> Rao', width = 375, patchFail = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const calls = [];
  const user = { id: 9, name, email: 'a@example.com', isAdmin: false, upiId: null, welcomedAt, termsAcceptedAt, inviterName };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      calls.push(['PATCH /me', req.postDataJSON()]);
      if (patchFail) return json(route, 400, { error: 'Enter a valid UPI ID, like name@bank', field: 'upiId' });
      Object.assign(user, req.postDataJSON());
    }
    return json(route, 200, { user });
  });
  await page.route('**/api/me/accept-terms', (route) => { calls.push(['POST accept-terms']); user.termsAcceptedAt = '2026-11-20T12:00:00.000Z'; return json(route, 200, { user }); });
  await page.route('**/api/me/welcomed', (route) => { calls.push(['POST welcomed']); user.welcomedAt = '2026-11-20T12:00:00.000Z'; return json(route, 200, { user }); });
  await page.route('**/api/feed', (route) => json(route, 200, { requests: [] }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#/home`, { waitUntil: 'load' });
  return { page, ctx, calls };
}

test('a first visit lands on step 1 with the name prefilled (escaped), optional UPI and a gated Continue', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.waitForSelector('#view-welcome:not([hidden]) h1');
    assert.match(page.url(), /#\/welcome$/);
    assert.equal(await page.inputValue('#w-name'), '<b>Asha</b> Rao');
    assert.equal(await page.locator('#welcome b').count(), 0, 'no markup injected from the name');
    assert.match(await page.locator('#welcome').innerText(), /so people can pay you in one tap/);
    for (const id of ['#w-name', '#w-upi', '#w-terms']) assert.ok(await page.locator(`label[for="${id.slice(1)}"]`).count(), `label for ${id}`);
    const cont = page.locator('#w-continue');
    assert.equal(await cont.isDisabled(), true, 'Continue is off until the terms are ticked');
    await page.check('#w-terms');
    assert.equal(await cont.isDisabled(), false);
    const box = await cont.boundingBox();
    assert.ok(box.height >= 44);
    assert.equal(calls.length, 0, 'nothing saved before Continue');
  } finally { await ctx.close(); }
});

test('three steps: save and accept terms, inviter line, rules, Finish goes home', { skip }, async () => {
  const { page, ctx, calls } = await open({ inviterName: 'Meera <i>Nair</i>' });
  try {
    await page.waitForSelector('#w-name');
    await page.fill('#w-name', 'Asha Rao');
    await page.fill('#w-upi', 'asha@okbank');
    await page.check('#w-terms');
    await page.click('#w-continue');
    await page.waitForSelector('#w-step-2');
    assert.deepEqual(calls.map((c) => c[0]).sort(), ['PATCH /me', 'POST accept-terms']);
    assert.deepEqual(calls.find((c) => c[0] === 'PATCH /me')[1], { name: 'Asha Rao', upiId: 'asha@okbank' });
    const t2 = await page.locator('#welcome').innerText();
    assert.match(t2, /You're connected with Meera <i>Nair<\/i>/);
    assert.match(t2, /invite one more person/i);
    assert.equal(await page.locator('#welcome i').count(), 0);
    await page.click('#w-next');
    await page.waitForSelector('#w-step-3');
    const t3 = await page.locator('#welcome').innerText();
    for (const re of [/₹50,000/, /12 months/, /no interest/i, /both sides confirm/i, /never holds money/i]) assert.match(t3, re);
    assert.doesNotMatch(t3, /nominee/i);
    assert.doesNotMatch(t3.replace(/no interest/gi, ''), /interest/i);
    assert.equal(calls.some((c) => c[0] === 'POST welcomed'), false);
    await page.click('#w-finish');
    await page.waitForFunction(() => location.hash === '#/home');
    assert.ok(calls.some((c) => c[0] === 'POST welcomed'));
    await page.waitForSelector('#view-feed:not([hidden])');
  } finally { await ctx.close(); }
});

test('with no inviter the connected line is skipped, and an empty UPI is not sent', { skip }, async () => {
  const { page, ctx, calls } = await open({ inviterName: null });
  try {
    await page.waitForSelector('#w-name');
    await page.check('#w-terms');
    await page.click('#w-continue');
    await page.waitForSelector('#w-step-2');
    assert.doesNotMatch(await page.locator('#welcome').innerText(), /connected with/i);
    assert.match(await page.locator('#welcome').innerText(), /invite one more person/i);
    assert.deepEqual(calls.find((c) => c[0] === 'PATCH /me')[1], { name: '<b>Asha</b> Rao' });
  } finally { await ctx.close(); }
});

test('a bad UPI shows its error on the field and stays on step 1', { skip }, async () => {
  const { page, ctx, calls } = await open({ patchFail: true });
  try {
    await page.waitForSelector('#w-name');
    await page.fill('#w-upi', 'nope');
    await page.check('#w-terms');
    await page.click('#w-continue');
    await page.waitForSelector('#w-upi[aria-invalid="true"]');
    assert.match(await page.locator('#w-e-upi').innerText(), /valid UPI/);
    assert.equal(await page.locator('#w-step-2').count(), 0);
    assert.equal(calls.some((c) => c[0] === 'POST accept-terms'), false);
  } finally { await ctx.close(); }
});

test('a member who is already welcomed goes straight to home', { skip }, async () => {
  const { page, ctx } = await open({ welcomedAt: '2026-11-01T00:00:00.000Z', termsAcceptedAt: '2026-11-01T00:00:00.000Z' });
  try {
    await page.waitForSelector('#view-feed:not([hidden])');
    assert.match(page.url(), /#\/home$|#$|\/app\/$/);
  } finally { await ctx.close(); }
});
