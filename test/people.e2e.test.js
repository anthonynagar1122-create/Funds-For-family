'use strict';
// Browser tests for the People page (invite sharing, suggestions) and invite acceptance, with MOCKED Clerk and API.
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
  async load(){} addListener(fn){ setTimeout(fn, 0); } mountUserButton(){} openSignIn(){} };`;

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

async function open(url, { suggestions = [], onAccept } = {}) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const json = (body) => (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', json({ clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', json({ user: { id: 9, name: 'Priya', email: 'p@example.com', isVerifier: false } }));
  await page.route('**/api/connections', json({ following: [{ id: 2, name: 'Asha' }], followers: [{ id: 2, name: 'Asha' }, { id: 3, name: 'Sam' }], mutual: [{ id: 2, name: 'Asha' }] }));
  await page.route('**/api/suggestions', json({ suggestions }));
  await page.route('**/api/invites', json({ link: 'https://ff.test/?invite=abcdefghijklmnopqrstuvwx' }));
  await page.route('**/api/invites/accept', async (r) => { onAccept?.(JSON.parse(r.request().postData())); await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ inviter: { id: 2, name: 'Asha' } }) }); });
  for (const p of ['feed', 'activity']) await page.route(`**/api/${p}`, json(p === 'feed' ? { requests: [] } : { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { nominee: [], verifier: [] } }));
  await page.goto(`http://127.0.0.1:${server.address().port}${url}`, { waitUntil: 'load' });
  return { page, ctx };
}

test('People: suggestions show the reason and mutual names, with a Follow button', { skip }, async () => {
  const { page, ctx } = await open('/#people', { suggestions: [
    { user: { id: 3, name: 'Sam' }, mutualCount: 0, mutualNames: [], reason: 'Follows you' },
    { user: { id: 7, name: 'Ravi' }, mutualCount: 4, mutualNames: ['Asha', 'Sam', 'Lee'], reason: '4 mutual connections' },
  ] });
  try {
    await page.waitForSelector('#suggestions-card:not([hidden])');
    const text = await page.locator('#suggestions').innerText();
    assert.match(text, /Sam[\s\S]*Follows you/);
    assert.match(text, /Ravi[\s\S]*4 mutual connections · Asha, Sam, Lee and others/);
    assert.equal(await page.locator('#suggestions [data-follow="7"]').count(), 1);
    // Connections: mutual shows Unfollow; a follower you don't follow shows Follow back.
    assert.equal(await page.locator('#connections [data-unfollow="2"]').count(), 1);
    assert.equal(await page.locator('#connections [data-follow="3"]').innerText(), 'Follow back');
  } finally { await ctx.close(); }
});

test('People: no suggestions hides the section', { skip }, async () => {
  const { page, ctx } = await open('/#people');
  try {
    await page.waitForSelector('#connections li');
    assert.equal(await page.locator('#suggestions-card').isVisible(), false);
  } finally { await ctx.close(); }
});

test('People: "Share invite link" gives the member a link to send', { skip }, async () => {
  const { page, ctx } = await open('/#people');
  try {
    await page.evaluate(() => { delete Navigator.prototype.share; });
    await page.click('#share-invite');
    await page.waitForFunction(() => document.querySelector('#invite-status').textContent.length > 0);
    assert.equal(await page.locator('#invite-link').inputValue(), 'https://ff.test/?invite=abcdefghijklmnopqrstuvwx');
    assert.match(await page.locator('#invite-status').textContent(), /copied|Copy this link/);
  } finally { await ctx.close(); }
});

test('Opening an invite link accepts it once after sign-in and cleans the address', { skip }, async () => {
  const accepted = [];
  const { page, ctx } = await open('/?invite=abcdefghijklmnopqrstuvwx#home', { onAccept: (b) => accepted.push(b.token) });
  try {
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await page.locator('#toast').textContent(), /connected with Asha/);
    await page.waitForTimeout(200);
    assert.deepEqual(accepted, ['abcdefghijklmnopqrstuvwx'], 'accepted exactly once');
    assert.equal(new URL(page.url()).search, '', 'invite token removed from the address bar');
  } finally { await ctx.close(); }
});
