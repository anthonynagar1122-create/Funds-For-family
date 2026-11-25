'use strict';
// Browser test of invite handling and the request form, with a MOCKED Clerk and MOCKED API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
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

async function open(hash, { me = (route) => json(route, 200, { user: { id: 9, name: 'Member', email: 'm@example.com' } }), extra } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const meHeaders = [];
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => { meHeaders.push(route.request().headers()['x-invite-token']); return me(route); });
  await page.route('**/api/feed', (route) => json(route, 200, { requests: [] }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  if (extra) await extra(page);
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  return { page, ctx, meHeaders };
}

test('#join=abc is sent as x-invite-token on the first /api/me and cleared once accepted', { skip }, async () => {
  const { page, ctx, meHeaders } = await open('#join=abc');
  try {
    await page.waitForSelector('#view-home:not([hidden])');
    assert.equal(meHeaders[0], 'abc');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ffjoin')), null, 'a used token is not kept');
    assert.doesNotMatch(await page.evaluate(() => location.hash), /join=/, 'token removed from the address bar');
  } finally { await ctx.close(); }
});

test('a rejected join token stays in sessionStorage under ffjoin', { skip }, async () => {
  const { page, ctx, meHeaders } = await open('#join=zzz', { me: (route) => json(route, 403, { error: 'invite only', code: 'invite_only' }) });
  try {
    await page.waitForSelector('#view-not-invited:not([hidden])');
    assert.equal(meHeaders[0], 'zzz');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ffjoin')), 'zzz');
  } finally { await ctx.close(); }
});

test('without a join hash no invite header is sent', { skip }, async () => {
  const { page, ctx, meHeaders } = await open('');
  try {
    await page.waitForSelector('#view-home:not([hidden])');
    assert.equal(meHeaders[0], undefined);
  } finally { await ctx.close(); }
});

test('a 403 invite_only shows the Not invited view', { skip }, async () => {
  const { page, ctx } = await open('', { me: (route) => json(route, 403, { error: 'Funds For Family is invite only', code: 'invite_only' }) });
  try {
    await page.waitForSelector('#view-not-invited:not([hidden])');
    const text = await page.locator('#view-not-invited').innerText();
    assert.match(text, /not invited/i);
    assert.match(text, /invite only/i);
    assert.equal(await page.locator('#view-home').isHidden(), true);
  } finally { await ctx.close(); }
});

test('the request form has category, trusted contact, rupee amount hint and a 12 month date limit', { skip }, async () => {
  const { page, ctx } = await open('#new', { extra: (p) => p.route('**/api/users', (route) => json(route, 200, { users: [{ id: 2, name: 'Nat' }] })) });
  try {
    await page.waitForSelector('#view-new:not([hidden])');
    await page.waitForSelector('#f-contact option[value="2"]', { state: 'attached' });
    const cats = await page.locator('#f-category option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
    assert.deepEqual(cats, ['education', 'medical', 'home', 'family_event', 'work', 'emergency', 'other']);
    assert.equal(await page.locator('label[for="f-contact"]').innerText(), 'Trusted contact');
    assert.equal(await page.locator('#f-contact').getAttribute('name'), 'trustedContactId');
    assert.equal(await page.locator('#f-amount').getAttribute('inputmode'), 'decimal');
    assert.match(await page.locator('#view-new').innerText(), /₹100 to ₹50,000/);
    const max = await page.locator('#f-date').getAttribute('max');
    const expected = new Date(); expected.setMonth(expected.getMonth() + 12);
    const diffDays = Math.abs(new Date(max) - expected) / 86400000;
    assert.ok(diffDays <= 2, `max ${max} is about 12 months ahead`);
    const text = await page.locator('#view-new').innerText();
    assert.doesNotMatch(text, /nominee|interest|\$|USD/i);
  } finally { await ctx.close(); }
});

test('submitting the form posts rupees as typed, category and trustedContactId', { skip }, async () => {
  let posted = null;
  const { page, ctx } = await open('#new', {
    extra: async (p) => {
      await p.route('**/api/users', (route) => json(route, 200, { users: [{ id: 2, name: 'Nat' }] }));
      await p.route('**/api/requests', (route) => { posted = route.request().postDataJSON(); return json(route, 201, { request: { id: 7 } }); });
    },
  });
  try {
    await page.waitForSelector('#f-contact option[value="2"]', { state: 'attached' });
    await page.fill('#f-amount', '1,500');
    await page.selectOption('#f-category', 'medical');
    await page.fill('#f-purpose', 'Surgery bill for the operation in March');
    await page.fill('#f-date', '2027-03-01');
    await page.selectOption('#f-contact', '2');
    await page.getByRole('button', { name: /send request/i }).click();
    await page.waitForFunction(() => location.hash === '#request/7');
    assert.deepEqual(posted, { amount: '1,500', purpose: 'Surgery bill for the operation in March', category: 'medical', repaymentDate: '2027-03-01', trustedContactId: 2 });
  } finally { await ctx.close(); }
});
