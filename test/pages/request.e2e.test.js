'use strict';
// Browser test of the request detail page with a MOCKED Clerk and MOCKED API.
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
  id: 1, borrowerId: 1, trustedContactId: 2, purpose: 'School fees', principalCents: 200000, repaymentDate: '2027-03-01',
  status: 'open', raisedCents: 0, remainingCents: 200000, totals: { confirmedCents: 0, pendingCents: 0 },
  lenders: [], payTo: [], daysOverdue: 0, verifications: [], contributions: [], repayments: [], ...over,
});
const lender = { userId: 5, lentCents: 150000, repaidCents: 20000, pendingRepayCents: 0, owedCents: 130000 };
const funded = (over = {}) => base({
  status: 'funded', raisedCents: 150000, remainingCents: 0, totals: { confirmedCents: 150000, pendingCents: 20000 }, lenders: [lender],
  contributions: [
    { id: 11, contributorId: 5, amountCents: 20000, utr: 'UTR123456', status: 'sent', createdAt: '2027-01-05T10:00:00.000Z', confirmedAt: null },
    { id: 12, contributorId: 5, amountCents: 150000, utr: null, status: 'confirmed', createdAt: '2027-01-02T10:00:00.000Z', confirmedAt: '2027-01-03T10:00:00.000Z' },
  ], ...over,
});

async function open(viewerId, request, { status = 200, width = 375 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const calls = [];
  const user = { id: viewerId, name: NAMES[viewerId] || 'Viewer', email: 'v@example.com', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/users/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    return json(route, 200, { user: { id, name: NAMES[id] || 'Member' } });
  });
  await page.route('**/api/requests/1', (route) => (status === 200 ? json(route, 200, { request }) : json(route, status, { error: 'Not found' })));
  await page.route(/\/api\/(requests\/1\/(contributions|repayments|contact-decision)|contributions\/\d+\/[a-z-]+|repayments\/\d+\/[a-z-]+)$/, (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.fallback();
    calls.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() });
    return json(route, 200, { ok: true });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#/request/1`, { waitUntil: 'load' });
  await page.waitForSelector('#detail h1', { state: 'attached' });
  return { page, ctx, calls };
}

test('progress shows text, aria-valuenow, solid confirmed and striped pending', { skip }, async () => {
  const { page, ctx } = await open(9, funded());
  try {
    const bar = page.locator('#detail [role="progressbar"]');
    assert.equal(await bar.getAttribute('aria-valuenow'), '75');
    assert.equal(await bar.locator('.progress-confirmed').count(), 1);
    assert.equal(await bar.locator('.progress-pending').count(), 1);
    const stripe = await bar.locator('.progress-pending').evaluate((el) => getComputedStyle(el).backgroundImage);
    assert.match(stripe, /gradient/);
    const text = await page.locator('#detail').innerText();
    assert.match(text, /₹1,500\.00 confirmed/);
    assert.match(text, /₹200\.00 pending/);
    assert.match(text, /of ₹2,000\.00/);
  } finally { await ctx.close(); }
});

test('lender rows show name, lent, repaid and owed in rupees', { skip }, async () => {
  const { page, ctx } = await open(9, funded());
  try {
    const row = await page.locator('.lender-row').first().innerText();
    assert.match(row, /Lena Shah/);
    assert.match(row, /lent ₹1,500\.00/);
    assert.match(row, /repaid ₹200\.00/);
    assert.match(row, /owed ₹1,300\.00/);
  } finally { await ctx.close(); }
});

test('UPI link is built only from payTo and shown on a phone; no QR there', { skip }, async () => {
  const { page, ctx } = await open(9, base({ remainingCents: 50000, payTo: [{ userId: 1, name: 'Ann Rao', upiId: 'ann@okbank' }] }));
  try {
    const link = page.locator('a.upi-pay');
    await link.waitFor({ state: 'visible' });
    assert.match(await link.innerText(), /^Pay ₹500\.00 with UPI$/);
    const u = new URL(await link.getAttribute('href'));
    assert.equal(u.protocol, 'upi:');
    assert.equal(u.searchParams.get('pa'), 'ann@okbank');
    assert.equal(u.searchParams.get('pn'), 'Ann Rao');
    assert.equal(u.searchParams.get('am'), '500.00');
    assert.equal(u.searchParams.get('cu'), 'INR');
    assert.equal(u.searchParams.get('tn'), 'Funds For Family request 1');
    assert.equal(await page.locator('.upi-qr svg').isVisible(), false);
    assert.ok((await link.boundingBox()).height >= 44);
    // The amount in the link follows what the lender types.
    await page.fill('#c-amount', '250.5');
    assert.match(await page.locator('a.upi-pay').innerText(), /^Pay ₹250\.50 with UPI$/);
    assert.equal(new URL(await page.locator('a.upi-pay').getAttribute('href')).searchParams.get('am'), '250.50');
  } finally { await ctx.close(); }
});

test('on a wide screen the UPI payment is a QR code drawn in the browser', { skip }, async () => {
  const { page, ctx } = await open(9, base({ remainingCents: 50000, payTo: [{ userId: 1, name: 'Ann Rao', upiId: 'ann@okbank' }] }), { width: 1280 });
  try {
    await page.locator('.upi-qr svg').waitFor({ state: 'visible' });
    assert.equal(await page.locator('a.upi-pay').isVisible(), false);
    assert.match(await page.locator('#detail').innerText(), /ann@okbank/);
  } finally { await ctx.close(); }
});

test('a payee with no UPI gets an ask button that opens WhatsApp', { skip }, async () => {
  const { page, ctx } = await open(9, base({ remainingCents: 50000, payTo: [] }));
  try {
    assert.equal(await page.locator('a.upi-pay').count(), 0);
    const ask = page.getByRole('link', { name: /Ask Ann Rao to add their UPI ID/ });
    assert.match(await ask.getAttribute('href'), /^https:\/\/wa\.me\/\?text=/);
    assert.ok((await ask.boundingBox()).height >= 44);
  } finally { await ctx.close(); }
});

test('a lender posts the amount and an optional UTR; a malformed UTR is stopped on the page', { skip }, async () => {
  const { page, ctx, calls } = await open(9, base({ remainingCents: 50000, payTo: [{ userId: 1, name: 'Ann Rao', upiId: 'ann@okbank' }] }));
  try {
    await page.fill('#c-amount', '1,500');
    await page.fill('#c-utr', 'bad utr!');
    await page.getByRole('button', { name: /I.ve sent it/ }).click();
    await page.waitForTimeout(150);
    assert.deepEqual(calls, []);
    assert.match(await page.locator('#e-fund').innerText(), /6 to 35/);
    await page.fill('#c-utr', 'UTR123456');
    await page.getByRole('button', { name: /I.ve sent it/ }).click();
    await page.waitForTimeout(150);
    assert.deepEqual(calls, [{ url: '/api/requests/1/contributions', body: { amount: '1,500', utr: 'UTR123456' } }]);
  } finally { await ctx.close(); }
});

test('the borrower sees Confirm and Not received only on sent contributions', { skip }, async () => {
  const { page, ctx, calls } = await open(1, funded());
  try {
    assert.equal(await page.locator('[data-confirm-contribution]').count(), 1);
    assert.equal(await page.locator('[data-notreceived-contribution]').count(), 1);
    await page.locator('[data-confirm-contribution="11"]').click();
    await page.waitForTimeout(150);
    assert.deepEqual(calls.map((c) => c.url), ['/api/contributions/11/confirm']);
  } finally { await ctx.close(); }
  const other = await open(9, funded());
  try { assert.equal(await other.page.locator('[data-confirm-contribution]').count(), 0); } finally { await other.ctx.close(); }
});

test('the borrower repays each lender by lenderId, with a UPI link per lender', { skip }, async () => {
  const two = [lender, { userId: 6, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }];
  const payTo = [{ userId: 5, name: 'Lena Shah', upiId: 'lena@okbank' }];
  const { page, ctx, calls } = await open(1, funded({ lenders: two, payTo }));
  try {
    assert.equal(await page.locator('.repay-form').count(), 2);
    assert.equal(await page.locator('.repay-form[data-lender="5"] a.upi-pay').count(), 1);
    assert.equal(await page.locator('.repay-form[data-lender="6"] a.upi-pay').count(), 0);
    assert.match(await page.locator('.repay-form[data-lender="6"]').innerText(), /Ask Raj Mehta to add their UPI ID/);
    assert.equal(await page.locator('.repay-form[data-lender="6"]').getByRole('button', { name: 'Record repayment' }).count(), 1);
    assert.equal(await page.locator('.repay-form').getByRole('button', { name: /I.ve sent it/ }).count(), 0);
    await page.locator('.repay-form[data-lender="5"] input[name="amount"]').fill('100.25');
    assert.match(await page.locator('.repay-form[data-lender="5"] a.upi-pay').innerText(), /^Pay ₹100\.25 with UPI$/);
    assert.equal(new URL(await page.locator('.repay-form[data-lender="5"] a.upi-pay').getAttribute('href')).searchParams.get('am'), '100.25');
    await page.locator('.repay-form[data-lender="6"] input[name="amount"]').fill('250');
    await page.locator('.repay-form[data-lender="6"]').getByRole('button', { name: 'Record repayment' }).click();
    await page.waitForTimeout(150);
    assert.deepEqual(calls, [{ url: '/api/requests/1/repayments', body: { lenderId: 6, amount: '250', utr: '' } }]);
  } finally { await ctx.close(); }
});

test('a request the viewer may not see shows only the unavailable message', { skip }, async () => {
  const { page, ctx } = await open(9, null, { status: 404 });
  try {
    await page.waitForFunction(() => /not available to you/.test(document.querySelector('#detail').innerText));
    const text = await page.locator('#detail').innerText();
    assert.match(text, /This request is not available to you/);
    assert.doesNotMatch(text, /School fees|₹/);
    assert.equal(await page.locator('#detail [role="progressbar"]').count(), 0);
  } finally { await ctx.close(); }
});

test('the repaid banner appears only when the request is repaid', { skip }, async () => {
  const a = await open(9, funded({ status: 'repaid' }));
  try { assert.equal(await a.page.locator('#repaid-banner').count(), 1); } finally { await a.ctx.close(); }
  const b = await open(9, funded());
  try { assert.equal(await b.page.locator('#repaid-banner').count(), 0); } finally { await b.ctx.close(); }
});

test('the timeline lists events newest first as text', { skip }, async () => {
  const { page, ctx } = await open(9, funded({ repayments: [{ id: 21, payerId: 1, lenderId: 5, amountCents: 20000, utr: null, status: 'confirmed', createdAt: '2027-02-01T10:00:00.000Z', confirmedAt: '2027-02-02T10:00:00.000Z' }] }));
  try {
    const items = await page.locator('#timeline li').allInnerTexts();
    assert.ok(items.length >= 5);
    assert.match(items[0], /repay|Repay/);
    assert.match(items[0], /Feb 2027/);
    assert.match(items[items.length - 1], /Jan 2027/);
  } finally { await ctx.close(); }
});

test('overdue shows a WhatsApp reminder for the borrower and trusted contact, not others', { skip }, async () => {
  const over = funded({ status: 'overdue', daysOverdue: 4 });
  for (const [id, expected] of [[1, 1], [2, 1], [9, 0]]) {
    const { page, ctx } = await open(id, over);
    try {
      const n = await page.locator('a.wa-reminder').count();
      assert.equal(n, expected, `viewer ${id}`);
      if (expected) assert.match(await page.locator('a.wa-reminder').getAttribute('href'), /^https:\/\/wa\.me\/\?text=/);
    } finally { await ctx.close(); }
  }
});

test('hostile purpose and names are escaped and no banned words appear', { skip }, async () => {
  const purpose = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>';
  const { page, ctx } = await open(9, funded({ purpose }));
  try {
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
    assert.equal(await page.locator('#detail img').count(), 0);
    assert.ok((await page.locator('#detail h1').innerText()).includes('<img src=x'));
    assert.doesNotMatch(await page.locator('#detail').innerText(), /nominee|interest/i);
  } finally { await ctx.close(); }
});

test('upiHref encodes name, UPI id and note; keeps @ in pa', { skip }, async () => {
  const { page, ctx } = await open(9, base());
  try {
    const href = await page.evaluate(() => window.RequestPage.upiHref({ name: 'A&B "x"', upiId: 'a&b@bank' }, 12345, 7));
    assert.match(href, /[?&]pa=a%26b@bank(&|$)/);
    assert.match(href, /[?&]pn=A%26B%20%22x%22(&|$)/);
    assert.match(href, /[?&]tn=Funds%20For%20Family%20request%207(&|$)/);
    assert.match(href, /[?&]am=123\.45(&|$)/);
    const u = new URL(href);
    assert.equal(u.searchParams.get('pn'), 'A&B "x"');
    assert.equal(u.searchParams.get('pa'), 'a&b@bank');
  } finally { await ctx.close(); }
});
