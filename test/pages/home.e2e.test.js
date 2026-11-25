'use strict';
// Browser test of the home overview with a MOCKED Clerk and MOCKED API.
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
const EMPTY = { needsYou: [], myRequests: [], myLending: [] };
const req = (o) => ({ id: 1, borrowerId: 9, trustedContactId: 2, purpose: 'School fees', principalCents: 1000000, status: 'open', repaymentDate: '2027-03-01', totals: { confirmedCents: 0, pendingCents: 0 }, ...o });

async function open(home, hash = '#/home') {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const user = { id: 9, name: 'Asha Rao', email: 'asha-secret@example.com', upiId: 'asha-secret@okbank', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  await routeClerk(page, CLERK_STUB);
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/feed', (route) => json(route, 200, { requests: [] }));
  await page.route('**/api/home', (route) => json(route, 200, home));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  return { page, ctx };
}

test('needs you comes first with a count, in API order, with rupees and names', { skip }, async () => {
  const { page, ctx } = await open({
    needsYou: [
      { kind: 'confirm_contribution', requestId: 5, entryId: 1, amountCents: 250000, fromUserId: 3, otherName: 'Meera Nair' },
      { kind: 'contact_decision', requestId: 6, otherName: 'Ravi Kumar' },
    ],
    myRequests: [req({ id: 5 })], myLending: [],
  });
  try {
    await page.waitForSelector('#view-home:not([hidden]) #needs-list');
    const headings = await page.locator('#home h2').allInnerTexts();
    assert.match(headings[0], /^Needs you \(2\)$/);
    assert.equal(await page.locator('#needs-count').innerText(), '2');
    const items = await page.locator('#needs-list li').allInnerTexts();
    assert.match(items[0], /Confirm ₹2,500.00 received from Meera Nair/);
    assert.match(items[1], /Ravi Kumar/);
    assert.equal(await page.locator('#needs-list li a').first().getAttribute('href'), '#/request/5');
    assert.equal(await page.locator('#needs-list li').nth(1).locator('a').first().getAttribute('href'), '#/request/6');
    const order = await page.evaluate(() => [...document.querySelectorAll('#home h1, #home h2')].map((h) => h.tagName + h.textContent));
    assert.match(order[1], /Needs you/);
    const box = await page.locator('#needs-list .btn').first().boundingBox();
    assert.ok(box.height >= 44);
  } finally { await ctx.close(); }
});

test('verifier items appear only when /home returns them', { skip }, async () => {
  const a = await open({ ...EMPTY, needsYou: [{ kind: 'verify', requestId: 8, otherName: 'Dev Patel' }] });
  try {
    await a.page.waitForSelector('#needs-list');
    assert.match(await a.page.locator('#needs-list').innerText(), /Verify a request from Dev Patel/);
  } finally { await a.ctx.close(); }
  const b = await open({ needsYou: [], myRequests: [req()], myLending: [] });
  try {
    await b.page.waitForSelector('#my-requests');
    assert.doesNotMatch(await b.page.locator('#home').innerText(), /Verify/);
    assert.equal(await b.page.locator('#needs-count').innerText(), '0');
  } finally { await b.ctx.close(); }
});

test('my request card shows confirmed and pending in rupees, a progress bar and status words', { skip }, async () => {
  const { page, ctx } = await open({ needsYou: [], myRequests: [req({ totals: { confirmedCents: 250000, pendingCents: 100000 } })], myLending: [] });
  try {
    await page.waitForSelector('#my-requests');
    const text = await page.locator('#my-requests').innerText();
    assert.match(text, /₹2,500.00 confirmed, ₹1,000.00 waiting for confirmation/);
    assert.match(text, /Open for funding/);
    assert.equal(await page.locator('#my-requests [role=progressbar]').getAttribute('aria-valuenow'), '25');
  } finally { await ctx.close(); }
});

test('my lending shows the amount still owed per request', { skip }, async () => {
  const { page, ctx } = await open({ needsYou: [], myRequests: [], myLending: [req({ id: 7, borrowerId: 4, status: 'funded', myLentCents: 300000, myRepaidCents: 50000, myOwedCents: 250000 })] });
  try {
    await page.waitForSelector('#my-lending');
    assert.match(await page.locator('#my-lending').innerText(), /₹2,500.00 still owed to you/);
    assert.equal(await page.locator('#my-lending a').first().getAttribute('href'), '#/request/7');
  } finally { await ctx.close(); }
});

test('a new member sees the empty state with both buttons; empty hash also renders home', { skip }, async () => {
  const { page, ctx } = await open(EMPTY, '');
  try {
    await page.waitForSelector('#home-empty');
    const start = page.locator('#home-empty a', { hasText: 'Start a request' });
    const invite = page.locator('#home-empty a', { hasText: 'Invite someone you trust' });
    assert.equal(await start.getAttribute('href'), '#/new');
    assert.equal(await invite.getAttribute('href'), '#/circle');
    assert.ok((await start.boundingBox()).height >= 44);
    assert.ok((await invite.boundingBox()).height >= 44);
  } finally { await ctx.close(); }
});

test('no email or UPI in the page; hostile names are escaped; no banned words', { skip }, async () => {
  const evil = '<img src=x onerror="window.__pwn=1">';
  const { page, ctx } = await open({
    needsYou: [{ kind: 'confirm_repayment', requestId: 3, entryId: 2, amountCents: 5000, fromUserId: 3, otherName: evil }],
    myRequests: [req({ purpose: '<b>bold</b>' })], myLending: [],
  });
  try {
    await page.waitForSelector('#needs-list');
    const html = await page.locator('#home').innerHTML();
    assert.equal(await page.locator('#home img, #home b').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
    assert.ok((await page.locator('#home').innerText()).includes(evil));
    assert.doesNotMatch(html, /secret@|@okbank|@example/);
    const text = await page.locator('#home').innerText();
    assert.doesNotMatch(text, /nominee|interest/i);
  } finally { await ctx.close(); }
});

test('the older feed is still reachable at #/feed', { skip }, async () => {
  const { page, ctx } = await open(EMPTY, '#/feed');
  try { await page.waitForSelector('#view-feed:not([hidden])'); } finally { await ctx.close(); }
});
