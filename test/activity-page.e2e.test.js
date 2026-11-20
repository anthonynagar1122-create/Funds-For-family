'use strict';
// Loop A browser test: "My activity" page, with MOCKED Clerk and MOCKED /api/activity.
// Proves the rendering against exit criteria 1–3 of .loop/activity-ledger/spec.md.
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

const EMPTY = { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { nominee: [], verifier: [] } };
const ROW = { requestId: 5, purpose: 'School fees for the second term', status: 'open', principalCents: 50000, repaymentDate: '2027-03-01', myRole: 'lender', myAmountCents: 10000 };

async function openActivity(activity) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(3000);
    await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
    await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
    await page.route('**/api/me', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }) }));
    await page.route('**/api/activity', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(activity) }));
    await page.goto(`http://127.0.0.1:${server.address().port}/app/#activity`, { waitUntil: 'load' });
    await page.waitForSelector('#activity-lending', { state: 'attached' });
    return page;
  } finally { /* context closed by caller */ }
}

test('the activity page has four groups: borrowing, lending, repayments, roles', { skip }, async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
  await page.route('**/api/me', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }) }));
  await page.route('**/api/activity', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(EMPTY) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#activity`, { waitUntil: 'load' });
  await page.waitForSelector('#activity-lending', { state: 'attached' });
  for (const g of ['borrowing', 'lending', 'repayments', 'roles']) {
    assert.equal(await page.locator(`#activity-${g}`).count(), 1, `group ${g} present`);
  }
  await ctx.close();
});

test('an empty ledger shows an empty state in every group, not an error', { skip }, async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
  await page.route('**/api/me', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }) }));
  await page.route('**/api/activity', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(EMPTY) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#activity`, { waitUntil: 'load' });
  // The groups exist before the API replies, so wait for the empty states the renderer adds.
  await page.waitForFunction(() => document.querySelectorAll('#view-activity .empty').length === 4, null, { timeout: 3000 });
  const empties = await page.locator('#view-activity .empty').count();
  assert.equal(empties, 4, 'one empty state per group');
  await ctx.close();
});

test('each activity row links to its request detail page', { skip }, async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
  await page.route('**/api/me', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }) }));
  await page.route('**/api/activity', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...EMPTY, lending: [ROW] }) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#activity`, { waitUntil: 'load' });
  await page.waitForSelector('#activity-lending a', { state: 'attached' });
  const href = await page.locator('#activity-lending a').first().getAttribute('href');
  assert.equal(href, '#request/5');
  await ctx.close();
});

test('the activity page never shows an email address', { skip }, async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
  await page.route('**/api/me', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Member', email: 'm@example.com', isVerifier: false } }) }));
  await page.route('**/api/activity', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...EMPTY, lending: [ROW] }) }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#activity`, { waitUntil: 'load' });
  await page.waitForSelector('#activity-lending a', { state: 'attached' });
  const text = await page.locator('#view-activity').innerText();
  assert.doesNotMatch(text, /@/);
  await ctx.close();
});
