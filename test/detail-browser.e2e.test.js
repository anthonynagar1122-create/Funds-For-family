'use strict';
// Browser test of the request detail page with a MOCKED Clerk and MOCKED API.
// This proves the page renders the right forms for each role in a real browser.
// It does NOT prove real sign-in or the real backend: those are verified separately (see the pilot ledger).
const { routeClerk } = require('./helpers/clerk-stub');
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

// viewer: { id, isVerifier }; request: detail payload from GET /api/requests/1
async function openDetail(viewer, request) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(3000);
    await routeClerk(page, CLERK_STUB);
    await page.route('**/api/config', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
    await page.route('**/api/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: viewer.id, name: 'Viewer', email: 'v@example.com', isVerifier: viewer.isVerifier } }) }));
    await page.route('**/api/users/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 1, name: 'Ann', isVerifier: false } }) }));
    await page.route('**/api/requests/1', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ request }) }));
    await page.goto(`http://127.0.0.1:${server.address().port}/app/#request/1`, { waitUntil: 'load' });
    await page.waitForSelector('#detail h1', { state: 'attached' });
    return {
      verify: await page.locator('#verify-form').count(),
      repay: await page.locator('.repay-form').count(),
      fund: await page.locator('#fund-form').count(),
    };
  } finally { await ctx.close(); }
}

const base = (over) => ({
  id: 1, borrowerId: 1, trustedContactId: 2, purpose: 'School fees for the second term at college', principalCents: 50000,
  repaymentDate: '2027-03-01', status: 'pending_verification', raisedCents: 0, remainingCents: 50000,
  totals: { confirmedCents: 0, pendingCents: 0 }, lenders: [], payTo: [], daysOverdue: 0, verifications: [], contributions: [], repayments: [],
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
  const f = await openDetail({ id: 1, isVerifier: false }, base({ status: 'funded', remainingCents: 0, raisedCents: 50000, totals: { confirmedCents: 50000, pendingCents: 0 }, lenders: [{ userId: 5, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }] }));
  assert.equal(f.repay, 1);
});

test('a stranger sees no repayment form on someone else\'s funded request', { skip }, async () => {
  const f = await openDetail({ id: 9, isVerifier: false }, base({ status: 'funded', remainingCents: 0, raisedCents: 50000, totals: { confirmedCents: 50000, pendingCents: 0 }, lenders: [{ userId: 5, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }] }));
  assert.equal(f.repay, 0);
});

test('a member sees the fund form only on an open request they did not create', { skip }, async () => {
  const f = await openDetail({ id: 9, isVerifier: false }, base({ status: 'open', verifications: [{ verifierId: 3, decision: 'approve', note: '' }] }));
  assert.equal(f.fund, 1);
  const own = await openDetail({ id: 1, isVerifier: false }, base({ status: 'open' }));
  assert.equal(own.fund, 0);
});

// ---- Two-step confirmation, per-lender repayment, trusted contact (minimal markup) ----

async function openPage(viewer, request, { posts = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const calls = [];
  await routeClerk(page, CLERK_STUB);
  await page.route('**/api/config', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
  await page.route('**/api/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: viewer.id, name: 'Viewer', email: 'v@example.com', isVerifier: !!viewer.isVerifier } }) }));
  await page.route('**/api/users/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 1, name: 'Ann', isVerifier: false } }) }));
  await page.route('**/api/requests/1', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ request }) }));
  await page.route(/\/api\/(requests\/1\/(contributions|repayments|contact-decision)|contributions\/\d+\/[a-z-]+|repayments\/\d+\/[a-z-]+)$/, (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    calls.push({ url: new URL(req.url()).pathname, body: req.postDataJSON(), ...(req.headers()['idempotency-key'] ? { idempotencyKey: req.headers()['idempotency-key'] } : {}) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#request/1`, { waitUntil: 'load' });
  await page.waitForSelector('#detail h1', { state: 'attached' });
  return { page, ctx, calls };
}

const lender = { userId: 5, lentCents: 150000, repaidCents: 0, pendingRepayCents: 0, owedCents: 150000 };
const funded = (over = {}) => base({
  status: 'funded', principalCents: 200000, raisedCents: 150000, remainingCents: 0,
  totals: { confirmedCents: 150000, pendingCents: 20000 }, pendingCents: 20000, lenders: [lender],
  contributions: [{ id: 11, contributorId: 5, amountCents: 20000, utr: 'UTR123456', status: 'sent' }, { id: 12, contributorId: 5, amountCents: 150000, utr: null, status: 'confirmed' }],
  ...over,
});

test('detail shows confirmed and pending in rupees, with no dollar, interest or nominee text', { skip }, async () => {
  const { page, ctx } = await openPage({ id: 9 }, funded());
  try {
    const text = await page.locator('#detail').innerText();
    assert.match(text, /₹1,500\.00 confirmed/);
    assert.match(text, /₹200\.00 pending/);
    assert.doesNotMatch(text, /\$|nominee|interest|amount due/i);
    assert.match(text, /Trusted contact/);
    assert.equal(await page.locator('.lender-row').count(), 1);
  } finally { await ctx.close(); }
});

test('the borrower can confirm or mark not received a sent contribution, and only sent ones', { skip }, async () => {
  const { page, ctx, calls } = await openPage({ id: 1 }, funded());
  try {
    assert.equal(await page.locator('[data-confirm-contribution]').count(), 1);
    assert.equal(await page.locator('[data-notreceived-contribution]').count(), 1);
    await page.locator('[data-confirm-contribution="11"]').click();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(100);
    assert.deepEqual(calls.map((c) => c.url), ['/api/contributions/11/confirm']);
  } finally { await ctx.close(); }
});

test('a stranger sees no confirm buttons on contributions', { skip }, async () => {
  const { page, ctx } = await openPage({ id: 9 }, funded());
  try {
    assert.equal(await page.locator('[data-confirm-contribution]').count(), 0);
  } finally { await ctx.close(); }
});

test('a lender on an open request sees "I\'ve sent it" with an optional UTR and posts rupees as typed', { skip }, async () => {
  const { page, ctx, calls } = await openPage({ id: 9 }, base({ status: 'open', remainingCents: 50000, payTo: [{ userId: 1, name: 'Ann', upiId: 'ann@okbank' }] }));
  try {
    assert.match(await page.locator('#detail').innerText(), /ann@okbank/);
    await page.fill('#c-amount', '1,500');
    await page.fill('#c-utr', 'UTR123456');
    await page.getByRole('button', { name: /I.ve sent it/ }).click();
    await page.waitForTimeout(100);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/requests/1/contributions');
    assert.deepEqual(calls[0].body, { amount: '1,500', utr: 'UTR123456' });
    assert.match(calls[0].idempotencyKey, /^[A-Za-z0-9._:-]{8,128}$/);
  } finally { await ctx.close(); }
});

test('the borrower repays each lender separately using lenderId', { skip }, async () => {
  const two = [lender, { userId: 6, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }];
  const { page, ctx, calls } = await openPage({ id: 1 }, funded({ lenders: two }));
  try {
    assert.equal(await page.locator('.repay-form').count(), 2);
    await page.locator('.repay-form[data-lender="6"] input[name="amount"]').fill('250');
    await page.locator('.repay-form[data-lender="6"] input[name="utr"]').fill('UTRREPAY6');
    await page.locator('.repay-form[data-lender="6"] button').click();
    await page.waitForTimeout(100);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/requests/1/repayments');
    assert.deepEqual(calls[0].body, { lenderId: 6, amount: '250', utr: 'UTRREPAY6' });
    assert.match(calls[0].idempotencyKey, /^[A-Za-z0-9._:-]{8,128}$/);
  } finally { await ctx.close(); }
});

test('a lender can confirm or mark not received a sent repayment addressed to them', { skip }, async () => {
  const repayments = [{ id: 21, payerId: 1, lenderId: 5, amountCents: 10000, utr: null, status: 'sent' }, { id: 22, payerId: 1, lenderId: 6, amountCents: 10000, utr: null, status: 'sent' }];
  const { page, ctx, calls } = await openPage({ id: 5 }, funded({ repayments }));
  try {
    assert.equal(await page.locator('[data-confirm-repayment]').count(), 1);
    await page.locator('[data-notreceived-repayment="21"]').click();
    await page.waitForTimeout(100);
    assert.deepEqual(calls.map((c) => c.url), ['/api/repayments/21/not-received']);
  } finally { await ctx.close(); }
});

test('the trusted contact can accept or decline while the request awaits their answer', { skip }, async () => {
  const { page, ctx, calls } = await openPage({ id: 2 }, base({ status: 'awaiting_contact' }));
  try {
    await page.getByRole('button', { name: 'Accept' }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(calls, [{ url: '/api/requests/1/contact-decision', body: { decision: 'accept' } }]);
  } finally { await ctx.close(); }
  const other = await openPage({ id: 9 }, base({ status: 'awaiting_contact' }));
  try {
    assert.equal(await other.page.getByRole('button', { name: 'Accept' }).count(), 0);
  } finally { await other.ctx.close(); }
});

test('untrusted text is escaped in the detail page', { skip }, async () => {
  const { page, ctx } = await openPage({ id: 9 }, funded({ purpose: '<img src=x onerror="window.__xss=1"> school fees for the term', payTo: [{ userId: 1, name: '<b>x</b>', upiId: 'a@b' }] }));
  try {
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#detail h1 img').count(), 0);
  } finally { await ctx.close(); }
});
