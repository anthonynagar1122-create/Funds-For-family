'use strict';
// Browser test of the request detail page with a MOCKED Clerk and MOCKED API.
// This proves the page renders the right forms for each role in a real browser.
// It does NOT prove real sign-in or the real backend: those are verified separately (see the pilot ledger).
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

// viewer: { id, isVerifier }; request: detail payload from GET /api/requests/1
async function openDetail(viewer, request) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(3000);
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
    await page.route('**/api/config', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
    await page.route('**/api/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: viewer.id, name: 'Viewer', email: 'v@example.com', isVerifier: viewer.isVerifier } }) }));
    await page.route('**/api/users/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 1, name: 'Ann', isVerifier: false } }) }));
    await page.route('**/api/requests/1', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ request }) }));
    await page.goto(`http://127.0.0.1:${server.address().port}/#request/1`, { waitUntil: 'load' });
    await page.waitForSelector('#detail h1', { state: 'attached' });
    return {
      verify: await page.locator('#verify-form').count(),
      repay: await page.locator('#repay-form').count(),
      fund: await page.locator('#fund-form').count(),
    };
  } finally { await ctx.close(); }
}

const base = (over) => ({
  id: 1, borrowerId: 1, nomineeId: 2, purpose: 'School fees for the second term at college', principalCents: 50000,
  repaymentDate: '2027-03-01', status: 'pending_verification', raisedCents: 0, remainingCents: 50000,
  amountDueCents: 50000, interestCents: 0, daysOverdue: 0, verifications: [], contributions: [], repayments: [],
  ...over,
});

test('a verifier sees the verify form on a pending request they did not create', { skip }, async () => {
  const f = await openDetail({ id: 3, isVerifier: true }, base({}));
  assert.equal(f.verify, 1);
});

test('the borrower never sees a verify form on their own request', { skip }, async () => {
  const f = await openDetail({ id: 1, isVerifier: true }, base({}));
  assert.equal(f.verify, 0);
});

test('a verifier who already decided sees no verify form', { skip }, async () => {
  const f = await openDetail({ id: 3, isVerifier: true }, base({ verifications: [{ verifierId: 3, decision: 'approve', note: '' }] }));
  assert.equal(f.verify, 0);
});

test('the borrower sees the repayment form on a funded request', { skip }, async () => {
  const f = await openDetail({ id: 1, isVerifier: false }, base({ status: 'funded', remainingCents: 0, raisedCents: 50000 }));
  assert.equal(f.repay, 1);
});

test('a stranger sees no repayment form on someone else\'s funded request', { skip }, async () => {
  const f = await openDetail({ id: 9, isVerifier: false }, base({ status: 'funded', remainingCents: 0, raisedCents: 50000 }));
  assert.equal(f.repay, 0);
});

test('a member sees the fund form only on an open request they did not create', { skip }, async () => {
  const f = await openDetail({ id: 9, isVerifier: false }, base({ status: 'open', verifications: [{ verifierId: 3, decision: 'approve', note: '' }] }));
  assert.equal(f.fund, 1);
  const own = await openDetail({ id: 1, isVerifier: false }, base({ status: 'open' }));
  assert.equal(own.fund, 0);
});
