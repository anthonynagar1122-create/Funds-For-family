'use strict';
// Browser test of Home ("Needs you now") with a MOCKED Clerk and MOCKED API.
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
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const EMPTY_ACTIVITY = { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { nominee: [], verifier: [] } };
const row = (requestId, status, myRole, repaymentDate, purpose = `Request ${requestId} purpose`) =>
  ({ requestId, purpose, status, principalCents: 50000, repaymentDate, myRole, myAmountCents: 0 });
const feedReq = (id, status, borrowerId) =>
  ({ id, purpose: `Feed request ${id}`, status, borrowerId, principalCents: 100000, raisedCents: 20000, repaymentDate: '2027-03-01' });

async function openHome({ isVerifier = false, feed = [], activity = EMPTY_ACTIVITY, queue = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const json = (body) => (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', json({ clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', json({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier } }));
  await page.route('**/api/feed', json({ requests: feed }));
  await page.route('**/api/activity', json(activity));
  await page.route('**/api/verification-queue', json({ requests: queue }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#view-home:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#home-empty').hidden || document.querySelector('#home-groups').children.length > 0);
  return { page, ctx };
}

test('home is the first screen and the menu marks it current', { skip }, async () => {
  const { page, ctx } = await openHome();
  try {
    assert.equal(await page.locator('#nav-home').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#signed-out').isVisible(), false, 'the sign-in panel stays hidden once signed in');
    assert.equal(await page.locator('#primary-nav').isVisible(), true);
    assert.equal(await page.locator('#tile-new').getAttribute('href'), '#new');
    assert.equal(await page.locator('#home-empty').isVisible(), true, 'empty state when nothing is waiting');
  } finally { await ctx.close(); }
});

test('the Verify tile appears only for verifiers', { skip }, async () => {
  const member = await openHome({ isVerifier: false });
  try { assert.equal(await member.page.locator('#tile-verify').isVisible(), false); } finally { await member.ctx.close(); }
  const verifier = await openHome({ isVerifier: true, queue: [{ id: 21, purpose: 'Needs a check', status: 'pending_verification', principalCents: 30000, approvals: 1, requiredApprovals: 2 }] });
  try {
    assert.equal(await verifier.page.locator('#tile-verify').isVisible(), true);
    assert.equal(await verifier.page.locator('#count-verify').textContent(), '1');
    assert.match(await verifier.page.locator('#group-verify').innerText(), /1 of 2 approvals/);
  } finally { await verifier.ctx.close(); }
});

test('repayments list overdue first; only funded or overdue requests count', { skip }, async () => {
  const activity = { ...EMPTY_ACTIVITY,
    borrowing: [row(1, 'funded', 'borrower', '2027-01-10'), row(2, 'open', 'borrower', '2027-01-01'), row(3, 'repaid', 'borrower', '2026-10-01')],
    roles: { nominee: [row(4, 'overdue', 'nominee', '2026-11-01')], verifier: [] } };
  const { page, ctx } = await openHome({ activity });
  try {
    assert.equal(await page.locator('#count-repay').textContent(), '2');
    const hrefs = await page.locator('#group-repay .task-title').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    assert.deepEqual(hrefs, ['#request/4', '#request/1'], 'overdue first');
    assert.equal(await page.locator('#group-repay .task.is-urgent').count(), 1);
  } finally { await ctx.close(); }
});

test('the Fund list offers open requests from others, never the member\'s own', { skip }, async () => {
  const feed = [feedReq(31, 'open', 2), feedReq(32, 'open', 9), feedReq(33, 'funded', 3)];
  const { page, ctx } = await openHome({ feed });
  try {
    assert.equal(await page.locator('#count-fund').textContent(), '1');
    const hrefs = await page.locator('#group-fund .task-title').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    assert.deepEqual(hrefs, ['#request/31']);
  } finally { await ctx.close(); }
});

test('a failing source shows an error instead of a false "nothing to do"', { skip }, async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  try {
    page.setDefaultTimeout(3000);
    const json = (body) => (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
    await page.route('**/api/config', json({ clerkPublishableKey: 'pk_test_mock' }));
    await page.route('**/api/me', json({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }));
    await page.route('**/api/feed', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server error"}' }));
    await page.route('**/api/activity', json(EMPTY_ACTIVITY));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForSelector('#home-groups .error');
    assert.equal(await page.locator('#home-empty').isVisible(), false);
    assert.equal(await page.locator('#count-fund').textContent(), '–', 'a failed list shows a dash, not a false zero');
    assert.equal(await page.locator('#count-repay').textContent(), '0');
  } finally { await ctx.close(); }
});
