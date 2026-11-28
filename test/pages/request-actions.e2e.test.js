'use strict';
// Browser tests (MOCKED Clerk and API) for the request page action buttons: withdraw, close early, pick another
// trusted contact, Try again, and Fix / Delete on a "not received" entry (gaps G-02 and G-03).
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
const NAMES = { 1: 'Ann Rao', 2: 'Tess Kumar', 5: 'Lena Shah', 6: 'Raj Mehta', 9: 'Viewer Nine' };

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
const base = (over) => ({
  id: 1, borrowerId: 1, trustedContactId: 2, purpose: 'School fees for the new term', category: 'education', principalCents: 200000,
  repaymentDate: '2027-03-01', status: 'open', raisedCents: 0, remainingCents: 200000, totals: { confirmedCents: 0, pendingCents: 0 },
  lenders: [], payTo: [], daysOverdue: 0, verifications: [], contributions: [], repayments: [], ...over,
});
const confirmedMoney = { totals: { confirmedCents: 150000, pendingCents: 0 }, raisedCents: 150000, remainingCents: 50000,
  contributions: [{ id: 12, contributorId: 5, amountCents: 150000, utr: null, status: 'confirmed', createdAt: '2027-01-02T10:00:00.000Z', confirmedAt: '2027-01-03T10:00:00.000Z' }] };

// post: optional (method, path) => { status, body } override. Every write call is recorded in `calls`.
async function open(viewerId, request, { hash = '#/request/1', post } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const calls = [];
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs += 1; d.dismiss(); });
  const user = { id: viewerId, name: NAMES[viewerId] || 'Viewer', email: 'v@example.com', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.route(/\/api\/users(\?.*)?$/, (route) => json(route, 200, { users: [{ id: 2, name: NAMES[2] }, { id: 6, name: NAMES[6] }] }));
  await page.route(/\/api\/users\/\d+$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    return json(route, 200, { user: { id, name: NAMES[id] || 'Member' } });
  });
  await page.route('**/api/requests/1', (route) => json(route, 200, { request }));
  await page.route(/\/api\/(requests\/1\/[a-z-]+|contributions\/\d+|repayments\/\d+)$/, (route) => {
    const r = route.request();
    if (r.method() === 'GET') return route.fallback();
    const pathname = new URL(r.url()).pathname;
    calls.push({ method: r.method(), url: pathname, body: r.postData() ? r.postDataJSON() : null });
    const over = post && post(r.method(), pathname);
    return over ? json(route, over.status, over.body) : json(route, 200, { ok: true, request });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  await page.waitForSelector('#detail h1, #new-root h1', { state: 'attached' });
  return { page, ctx, calls, dialogs: () => dialogs };
}

const buttonNames = (page) => page.locator('#detail button, #detail a.btn').allInnerTexts();

// ---- G-02: withdraw ----
test('borrower can withdraw an awaiting-contact request after an in-page confirm step', { skip }, async () => {
  const { page, ctx, calls, dialogs } = await open(1, base({ status: 'awaiting_contact' }));
  try {
    const btn = page.getByRole('button', { name: 'Withdraw request' });
    assert.ok((await btn.boundingBox()).height >= 44);
    await btn.click();
    assert.equal(calls.length, 0, 'nothing is sent before the confirm step');
    await page.getByRole('button', { name: 'Yes, withdraw it' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/requests/1/withdraw']);
    assert.equal(dialogs(), 0, 'no window.confirm');
  } finally { await ctx.close(); }
});

test('withdraw confirm can be cancelled; a server refusal is shown in the form and the button re-enables', { skip }, async () => {
  const { page, ctx, calls } = await open(1, base({ status: 'pending_verification' }), { post: () => ({ status: 409, body: { error: 'This request can no longer be withdrawn <b>x</b>' } }) });
  try {
    await page.getByRole('button', { name: 'Withdraw request' }).click();
    await page.getByRole('button', { name: 'Keep my request' }).click();
    assert.equal(await page.getByRole('button', { name: 'Yes, withdraw it' }).count(), 0);
    await page.getByRole('button', { name: 'Withdraw request' }).click();
    await page.getByRole('button', { name: 'Yes, withdraw it' }).click();
    const err = page.locator('#owner-error');
    await page.waitForFunction(() => document.querySelector('#owner-error')?.textContent);
    assert.equal(await err.textContent(), 'This request can no longer be withdrawn <b>x</b>');
    assert.equal(calls.length, 1);
    assert.equal(await page.getByRole('button', { name: 'Yes, withdraw it' }).isDisabled(), false);
  } finally { await ctx.close(); }
});

// ---- G-02: close early ----
test('borrower sees "Close with ₹1,500.00" (not Withdraw) on a part-funded open request and confirms it', { skip }, async () => {
  const { page, ctx, calls } = await open(1, base(confirmedMoney));
  try {
    assert.equal(await page.getByRole('button', { name: 'Withdraw request' }).count(), 0);
    await page.getByRole('button', { name: 'Close with ₹1,500.00' }).click();
    assert.equal(calls.length, 0);
    assert.match(await page.locator('#owner-confirm').innerText(), /₹1,500\.00/);
    await page.getByRole('button', { name: 'Yes, close it' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/requests/1/close']);
  } finally { await ctx.close(); }
});

test('owner controls are hidden when the API would refuse them', { skip }, async () => {
  for (const [viewer, req] of [
    [1, base({ status: 'open' })], // open with no money: withdraw only (no close)
    [1, base({ status: 'funded', ...confirmedMoney })],
    [1, base({ status: 'repaid', ...confirmedMoney })],
    [9, base({ status: 'open' })],
    [2, base({ status: 'awaiting_contact' })],
  ]) {
    const { page, ctx } = await open(viewer, req);
    try {
      const names = await buttonNames(page);
      const hasClose = names.some((n) => /^Close with/.test(n));
      assert.equal(hasClose, false, `${viewer}/${req.status}`);
      const hasWithdraw = names.includes('Withdraw request');
      assert.equal(hasWithdraw, viewer === 1 && req.status === 'open', `${viewer}/${req.status} withdraw`);
    } finally { await ctx.close(); }
  }
});

// ---- G-02: pick another trusted contact ----
test('after a decline the borrower picks another trusted contact (the decliner is not offered)', { skip }, async () => {
  const { page, ctx, calls } = await open(1, base({ status: 'contact_declined' }));
  try {
    const select = page.locator('#repick-contact');
    const options = await select.locator('option').allInnerTexts();
    assert.ok(options.some((o) => o === 'Raj Mehta'));
    assert.ok(!options.some((o) => o === 'Tess Kumar'), 'the contact who declined is excluded');
    assert.ok((await select.boundingBox()).height >= 44);
    assert.ok(await page.locator('label[for="repick-contact"]').count());
    await page.getByRole('button', { name: 'Send to this contact' }).click();
    assert.equal(calls.length, 0, 'must choose someone first');
    assert.match(await page.locator('#owner-error').textContent(), /Choose/);
    await select.selectOption('6');
    await page.getByRole('button', { name: 'Send to this contact' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls.map((c) => ({ m: c.method, u: c.url, b: c.body })), [{ m: 'POST', u: '/api/requests/1/trusted-contact', b: { userId: 6 } }]);
  } finally { await ctx.close(); }
});

// ---- G-02: rejected -> Try again ----
test('a rejected request shows the reason to the borrower and Try again opens the form prefilled', { skip }, async () => {
  const { page, ctx } = await open(1, base({ status: 'rejected', rejectionReason: 'Please explain what the fees are for.' }));
  try {
    assert.match(await page.locator('#detail').innerText(), /Please explain what the fees are for\./);
    const again = page.getByRole('link', { name: 'Try again' });
    assert.ok((await again.boundingBox()).height >= 44);
    await again.click();
    await page.waitForSelector('#new-form');
    assert.equal(await page.inputValue('#f-amount'), '2000');
    assert.equal(await page.inputValue('#f-purpose'), 'School fees for the new term');
    assert.equal(await page.inputValue('#f-category'), 'education');
    assert.equal(await page.inputValue('#f-contact'), '2');
  } finally { await ctx.close(); }
});

test('Try again on a request that is not the viewer\'s own rejected one gives a blank form', { skip }, async () => {
  const { page, ctx } = await open(9, base({ status: 'rejected' }), { hash: '#/new/1' });
  try {
    await page.waitForSelector('#new-form');
    assert.equal(await page.inputValue('#f-amount'), '');
    assert.equal(await page.inputValue('#f-purpose'), '');
  } finally { await ctx.close(); }
});

test('a rejected request offers no Try again to other members', { skip }, async () => {
  const { page, ctx } = await open(9, base({ status: 'rejected' }));
  try { assert.equal(await page.getByRole('link', { name: 'Try again' }).count(), 0); } finally { await ctx.close(); }
});

// ---- G-03: Fix and Delete ----
const notReceivedContribution = () => base({
  status: 'open', ...confirmedMoney,
  contributions: [...confirmedMoney.contributions, { id: 11, contributorId: 5, amountCents: 20000, utr: 'UTR123456', status: 'not_received', createdAt: '2027-01-05T10:00:00.000Z', confirmedAt: null }],
});

test('lender can correct a not-received contribution (amount and optional UTR) from the page', { skip }, async () => {
  const { page, ctx, calls } = await open(5, notReceivedContribution());
  try {
    assert.equal(await page.locator('#contribution-12 [data-fix]').count(), 0, 'confirmed entries have no Fix');
    await page.locator('#contribution-11').getByRole('button', { name: 'Fix' }).click();
    const form = page.locator('#contribution-11 form.fix-form');
    assert.equal(await form.locator('input[name="amount"]').inputValue(), '200.00');
    assert.equal(await form.locator('input[name="utr"]').inputValue(), 'UTR123456');
    assert.ok(await form.locator('label[for="fix-amount-contribution-11"]').count());
    await form.locator('input[name="utr"]').fill('bad');
    await form.getByRole('button', { name: 'Save correction' }).click();
    assert.match(await form.locator('.error').textContent(), /6 to 35/);
    assert.equal(calls.length, 0);
    await form.locator('input[name="amount"]').fill('250');
    await form.locator('input[name="utr"]').fill('');
    await form.getByRole('button', { name: 'Save correction' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls.map((c) => ({ m: c.method, u: c.url, b: c.body })), [{ m: 'PATCH', u: '/api/contributions/11', b: { amount: '250', utr: '' } }]);
  } finally { await ctx.close(); }
});

test('Fix shows the server error text and keeps the form open', { skip }, async () => {
  const { page, ctx } = await open(5, notReceivedContribution(), { post: () => ({ status: 409, body: { error: 'That would be more than is still needed <i>x</i>' } }) });
  try {
    await page.locator('#contribution-11').getByRole('button', { name: 'Fix' }).click();
    const form = page.locator('#contribution-11 form.fix-form');
    await form.getByRole('button', { name: 'Save correction' }).click();
    await page.waitForFunction(() => document.querySelector('#contribution-11 .fix-form .error')?.textContent);
    assert.equal(await form.locator('.error').textContent(), 'That would be more than is still needed <i>x</i>');
    assert.equal(await form.getByRole('button', { name: 'Save correction' }).isDisabled(), false);
  } finally { await ctx.close(); }
});

test('lender can delete a not-received contribution after an in-page confirm', { skip }, async () => {
  const { page, ctx, calls, dialogs } = await open(5, notReceivedContribution());
  try {
    await page.locator('#contribution-11').getByRole('button', { name: 'Delete' }).click();
    assert.equal(calls.length, 0);
    await page.locator('#contribution-11').getByRole('button', { name: 'Yes, delete it' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['DELETE /api/contributions/11']);
    assert.equal(dialogs(), 0);
  } finally { await ctx.close(); }
});

test('only the sender sees Fix/Delete: borrower and other members do not', { skip }, async () => {
  for (const viewer of [1, 9]) {
    const { page, ctx } = await open(viewer, notReceivedContribution());
    try { assert.equal(await page.locator('#contribution-11 [data-fix]').count(), 0, `viewer ${viewer}`); } finally { await ctx.close(); }
  }
});

test('payer can correct and delete a not-received repayment', { skip }, async () => {
  const req = base({
    status: 'funded', ...confirmedMoney, lenders: [{ userId: 5, lentCents: 150000, repaidCents: 0, pendingRepayCents: 0, owedCents: 150000 }],
    repayments: [{ id: 21, payerId: 1, lenderId: 5, amountCents: 30000, utr: null, status: 'not_received', createdAt: '2027-02-01T10:00:00.000Z', confirmedAt: null }],
  });
  const { page, ctx, calls } = await open(1, req);
  try {
    assert.equal(await page.locator('#repayment-21 [data-fix]').count(), 2, 'Fix and Delete');
    await page.locator('#repayment-21').getByRole('button', { name: 'Fix' }).click();
    const form = page.locator('#repayment-21 form.fix-form');
    await form.locator('input[name="amount"]').fill('300.50');
    await form.locator('input[name="utr"]').fill('REF987654');
    await form.getByRole('button', { name: 'Save correction' }).click();
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.deepEqual(calls[0], { method: 'PATCH', url: '/api/repayments/21', body: { amount: '300.50', utr: 'REF987654' } });
    await page.locator('#repayment-21').getByRole('button', { name: 'Delete' }).click();
    await page.locator('#repayment-21').getByRole('button', { name: 'Yes, delete it' }).click();
    for (let i = 0; i < 40 && calls.length < 2; i += 1) await page.waitForTimeout(50);
    assert.equal(calls[calls.length - 1].method, 'DELETE');
    assert.equal(calls[calls.length - 1].url, '/api/repayments/21');
  } finally { await ctx.close(); }
});

test('the Home "Fix" link lands on the entry: it is scrolled into view and focused', { skip }, async () => {
  const { page, ctx } = await open(5, notReceivedContribution(), { hash: '#/request/1/contribution-11' });
  try {
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'contribution-11');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'contribution-11');
    assert.equal(await page.locator('#contribution-11').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
  } finally { await ctx.close(); }
});
