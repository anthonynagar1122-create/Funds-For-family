'use strict';
// Browser test of the new request form with a MOCKED Clerk and MOCKED API.
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
const NAT = { id: 2, name: 'Nat Rao' };

async function open({ users = [NAT], home = { needsYou: [], myRequests: [], myLending: [] }, onPost } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const user = { id: 9, name: 'Asha Rao', email: 'a@example.com', upiId: 'a@okbank', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  await routeClerk(page, CLERK_STUB);
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/home', (route) => json(route, 200, home));
  await page.route('**/api/users*', (route) => json(route, 200, { users }));
  await page.route('**/api/requests', (route) => (onPost ? onPost(route) : json(route, 201, { request: { id: 7 } })));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#/new`, { waitUntil: 'load' });
  return { page, ctx };
}

test('amount shows a live rupee value on blur and the limit hint', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#f-amount');
    assert.match(await page.locator('#view-new').innerText(), /₹100 to ₹50,000/);
    assert.equal(await page.locator('#f-amount').getAttribute('inputmode'), 'decimal');
    await page.fill('#f-amount', '12500');
    await page.locator('#f-amount').blur();
    assert.match(await page.locator('#amount-preview').innerText(), /₹12,500\.00/);
    assert.equal(await page.locator('#e-amount').innerText(), '');
  } finally { await ctx.close(); }
});

test('amount outside the limits shows an inline error before submit', { skip }, async () => {
  let posts = 0;
  const { page, ctx } = await open({ onPost: (r) => { posts += 1; return json(r, 201, { request: { id: 7 } }); } });
  try {
    await page.waitForSelector('#f-amount');
    await page.fill('#f-amount', '50');
    await page.locator('#f-amount').blur();
    assert.match(await page.locator('#e-amount').innerText(), /₹100 to ₹50,000/);
    await page.fill('#f-amount', '50001');
    await page.locator('#f-amount').blur();
    assert.match(await page.locator('#e-amount').innerText(), /₹100 to ₹50,000/);
    assert.equal(await page.locator('#f-amount').getAttribute('aria-invalid'), 'true');
    await page.getByRole('button', { name: /send request/i }).click();
    assert.equal(posts, 0);
  } finally { await ctx.close(); }
});

test('purpose has a live character count', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#f-purpose');
    assert.match(await page.locator('#purpose-count').innerText(), /0 of 2,000/);
    await page.fill('#f-purpose', 'Fees for term two');
    assert.match(await page.locator('#purpose-count').innerText(), /17 of 2,000/);
    assert.match(await page.locator('#view-new').innerText(), /20/);
  } finally { await ctx.close(); }
});

test('due date runs from tomorrow to 12 months ahead', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#f-date');
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const limit = new Date(); limit.setMonth(limit.getMonth() + 12);
    const min = await page.locator('#f-date').getAttribute('min');
    const max = await page.locator('#f-date').getAttribute('max');
    assert.ok(Math.abs(new Date(min) - new Date(iso(tomorrow))) <= 86400000, `min ${min}`);
    assert.ok(Math.abs(new Date(max) - new Date(iso(limit))) <= 86400000 * 2, `max ${max}`);
  } finally { await ctx.close(); }
});

test('category select has the seven values', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#f-category');
    const opts = await page.locator('#f-category option').evaluateAll((o) => o.filter((x) => x.value).map((x) => [x.value, x.textContent]));
    assert.deepEqual(opts, [['education', 'Education'], ['medical', 'Medical'], ['home', 'Home'], ['family_event', 'Family event'], ['work', 'Work or business'], ['emergency', 'Emergency'], ['other', 'Other']]);
  } finally { await ctx.close(); }
});

test('picker lists only mutual connections from the empty-query list', { skip }, async () => {
  const urls = [];
  const { page, ctx } = await open({ users: [NAT, { id: 3, name: 'Meera Nair' }] });
  page.on('request', (r) => { if (r.url().includes('/api/users')) urls.push(r.url()); });
  try {
    await page.waitForSelector('#f-contact option[value="2"]', { state: 'attached' });
    const names = await page.locator('#f-contact option[value]:not([value=""])').allInnerTexts();
    assert.deepEqual(names, ['Nat Rao', 'Meera Nair']);
    assert.equal(await page.locator('label[for="f-contact"]').innerText(), 'Trusted contact');
  } finally { await ctx.close(); }
});

test('with no mutual connections it says to connect first and links to Circle', { skip }, async () => {
  const { page, ctx } = await open({ users: [] });
  try {
    await page.waitForSelector('#contact-empty');
    assert.match(await page.locator('#contact-empty').innerText(), /Connect with someone first/);
    assert.equal(await page.locator('#contact-empty a').getAttribute('href'), '#/circle');
    assert.equal(await page.locator('#f-contact').count(), 0);
  } finally { await ctx.close(); }
});

test('an active request replaces the form with an explanation and a link', { skip }, async () => {
  const home = { needsYou: [], myLending: [], myRequests: [{ id: 5, status: 'open', purpose: 'School fees', principalCents: 1000000, totals: {} }] };
  const { page, ctx } = await open({ home });
  try {
    await page.waitForSelector('#active-request');
    assert.match(await page.locator('#active-request').innerText(), /You already have an active request/);
    assert.equal(await page.locator('#active-request a').first().getAttribute('href'), '#/request/5');
    assert.equal(await page.locator('#new-form').count(), 0);
  } finally { await ctx.close(); }
});

test('a finished request does not block a new one', { skip }, async () => {
  const home = { needsYou: [], myLending: [], myRequests: [{ id: 5, status: 'repaid', purpose: 'Old', principalCents: 1000000, totals: {} }] };
  const { page, ctx } = await open({ home });
  try {
    await page.waitForSelector('#new-form');
    assert.equal(await page.locator('#active-request').count(), 0);
  } finally { await ctx.close(); }
});

async function fillValid(page) {
  await page.waitForSelector('#f-contact option[value="2"]', { state: 'attached' });
  await page.fill('#f-amount', '1,500');
  await page.selectOption('#f-category', 'medical');
  await page.fill('#f-purpose', 'Surgery bill for the operation in March');
  await page.fill('#f-date', await page.locator('#f-date').getAttribute('max'));
  await page.selectOption('#f-contact', '2');
}

test('double submit sends one request and shows Sending while in flight', { skip }, async () => {
  let posts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { page, ctx } = await open({ onPost: async (route) => { posts += 1; await gate; return json(route, 201, { request: { id: 7 } }); } });
  try {
    await fillValid(page);
    const btn = page.locator('#new-form button[type="submit"]');
    await btn.click();
    await page.waitForFunction(() => document.querySelector('#new-form button[type="submit"]').disabled);
    assert.match(await btn.innerText(), /Sending…/);
    await page.locator('#new-form').evaluate((f) => f.requestSubmit());
    release();
    await page.waitForFunction(() => location.hash === '#request/7');
    assert.equal(posts, 1);
  } finally { await ctx.close(); }
});

test('posts the typed amount string with category and trusted contact', { skip }, async () => {
  let posted = null;
  const { page, ctx } = await open({ onPost: (route) => { posted = route.request().postDataJSON(); return json(route, 201, { request: { id: 7 } }); } });
  try {
    await fillValid(page);
    const date = await page.locator('#f-date').inputValue();
    await page.getByRole('button', { name: /send request/i }).click();
    await page.waitForFunction(() => location.hash === '#request/7');
    assert.deepEqual(posted, { amount: '1,500', purpose: 'Surgery bill for the operation in March', category: 'medical', repaymentDate: date, trustedContactId: 2 });
  } finally { await ctx.close(); }
});

test('a 400 with field repaymentDate shows the error on the date input', { skip }, async () => {
  const { page, ctx } = await open({ onPost: (route) => json(route, 400, { error: 'Pick a date within 12 months', field: 'repaymentDate' }) });
  try {
    await fillValid(page);
    await page.getByRole('button', { name: /send request/i }).click();
    await page.waitForFunction(() => document.getElementById('e-date').textContent.includes('within 12 months'));
    assert.equal(await page.locator('#f-date').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#new-form button[type="submit"]').isDisabled(), false);
  } finally { await ctx.close(); }
});

test('a 409 shows its message as text in the form and re-enables the button', { skip }, async () => {
  const { page, ctx } = await open({ onPost: (route) => json(route, 409, { error: 'This person is already the trusted contact on 3 requests' }) });
  try {
    await fillValid(page);
    await page.getByRole('button', { name: /send request/i }).click();
    await page.waitForFunction(() => document.getElementById('e-form').textContent.includes('already the trusted contact'));
    assert.equal(await page.locator('#new-form button[type="submit"]').isDisabled(), false);
    assert.doesNotMatch(await page.locator('#view-new').innerText(), /nominee|interest/i);
  } finally { await ctx.close(); }
});
