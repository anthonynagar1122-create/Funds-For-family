'use strict';
// Browser tests for Your profile and member profiles, with MOCKED Clerk and API.
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

async function open(url, { member, onPhone } = {}) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const json = (body) => (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', json({ clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', json({ user: { id: 9, name: 'Priya Shah', email: 'priya@example.com', phone: null, isVerifier: true } }));
  await page.route('**/api/me/phone', async (r) => {
    const body = JSON.parse(r.request().postData());
    onPhone?.(body);
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { id: 9, name: 'Priya Shah', phone: '+919876543210' } }) });
  });
  await page.route('**/api/connections', json({ following: [{ id: 2, name: 'Asha' }], followers: [{ id: 2, name: 'Asha' }, { id: 3, name: 'Sam' }], mutual: [{ id: 2, name: 'Asha' }] }));
  if (member) await page.route(`**/api/users/${member.user.id}`, json(member));
  await page.route('**/api/feed', json({ requests: [
    { id: 41, borrowerId: 2, status: 'open', purpose: 'New school uniform', principalCents: 20000, raisedCents: 5000, repaymentDate: '2027-01-10' },
    { id: 42, borrowerId: 3, status: 'open', purpose: 'Someone else', principalCents: 20000, raisedCents: 0, repaymentDate: '2027-01-10' },
  ] }));
  await page.goto(`http://127.0.0.1:${server.address().port}${url}`, { waitUntil: 'load' });
  return { page, ctx };
}

test('Your profile shows who you are and your circle counts', { skip }, async () => {
  const { page, ctx } = await open('/#profile');
  try {
    await page.waitForSelector('#view-profile:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#profile-following').textContent !== '–');
    assert.equal(await page.locator('#profile-name').textContent(), 'Priya Shah');
    assert.equal(await page.locator('#profile-email').textContent(), 'priya@example.com');
    assert.equal(await page.locator('#profile-avatar').textContent(), 'PS');
    assert.match(await page.locator('#profile-badges').textContent(), /Verifier/);
    assert.equal(await page.locator('#profile-following').textContent(), '1');
    assert.equal(await page.locator('#profile-followers').textContent(), '2');
    assert.equal(await page.locator('#nav-profile').getAttribute('aria-current'), 'page');
  } finally { await ctx.close(); }
});

test('Your profile saves your phone number', { skip }, async () => {
  const sent = [];
  const { page, ctx } = await open('/#profile', { onPhone: (b) => sent.push(b.phone) });
  try {
    await page.waitForSelector('#view-profile:not([hidden])');
    await page.fill('#p-phone', '+91 98765 43210');
    await page.click('#phone-form button[type="submit"]');
    await page.waitForSelector('#toast:not([hidden])');
    assert.deepEqual(sent, ['+91 98765 43210']);
    assert.equal(await page.locator('#p-phone').inputValue(), '+919876543210', 'shown in the saved format');
  } finally { await ctx.close(); }
});

test('A member who follows you: Call / WhatsApp and their open requests', { skip }, async () => {
  const member = { user: { id: 2, name: 'Asha Rao', isVerifier: false, phone: '+919876543210' }, relationship: { youFollow: true, followsYou: true } };
  const { page, ctx } = await open('/#member/2', { member });
  try {
    await page.waitForSelector('#member-contact .contact');
    assert.equal(await page.locator('#member-title').textContent(), 'Asha Rao');
    assert.match(await page.locator('#member-badges').textContent(), /Mutual/);
    assert.equal(await page.locator('#member-contact a[href^="tel:"]').getAttribute('href'), 'tel:+919876543210');
    assert.equal(await page.locator('#member-contact a[href^="https://wa.me/"]').getAttribute('href'), 'https://wa.me/919876543210');
    await page.waitForSelector('#member-requests-card:not([hidden])');
    assert.deepEqual(await page.locator('#member-requests .task-title').evaluateAll((e) => e.map((x) => x.getAttribute('href'))), ['#request/41']);
    assert.equal(await page.locator('#member-actions [data-unfollow="2"]').count(), 1);
  } finally { await ctx.close(); }
});

test('A member who does not follow you: no phone, a clear note, and a Follow button', { skip }, async () => {
  const member = { user: { id: 7, name: 'Ravi', isVerifier: false }, relationship: { youFollow: false, followsYou: false } };
  const { page, ctx } = await open('/#member/7', { member });
  try {
    await page.waitForSelector('#member-contact .member-note');
    assert.match(await page.locator('#member-contact').textContent(), /appear once they follow you/);
    assert.equal(await page.locator('#member-contact a[href^="tel:"]').count(), 0);
    assert.equal(await page.locator('#member-actions [data-follow="7"]').textContent(), 'Follow');
    assert.equal(await page.locator('#member-requests-card').isVisible(), false);
  } finally { await ctx.close(); }
});
