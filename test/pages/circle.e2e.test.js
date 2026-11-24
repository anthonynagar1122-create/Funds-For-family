'use strict';
// Browser test of the circle page with a MOCKED Clerk and MOCKED API.
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
const U = (id, name) => ({ id, name, email: `${name.split(' ')[0].toLowerCase()}-secret@example.com`, upiId: `${name.split(' ')[0].toLowerCase()}@okbank` });
const MEERA = U(3, 'Meera Nair'); const RAVI = U(4, 'Ravi Kumar'); const SITA = U(5, 'Sita Devi');
const TOKEN = 'tok_abc123SECRETtoken';
const LINK = `http://localhost/app/#join=${TOKEN}`;

async function open(opts = {}) {
  const state = { connections: { following: [MEERA, RAVI], followers: [MEERA, SITA], mutual: [MEERA] }, invites: [], posts: [], deletes: [], ...opts };
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const user = { id: 9, name: 'Asha Rao', email: 'asha-secret@example.com', upiId: 'asha-secret@okbank', isAdmin: false, welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user }));
  await page.route('**/api/feed', (route) => json(route, 200, { requests: [] }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.route('**/api/connections', (route) => json(route, 200, state.connections));
  await page.route('**/api/follows/*', (route) => {
    const id = Number(route.request().url().split('/').pop());
    state.unfollows = [...(state.unfollows || []), { method: route.request().method(), id }];
    const c = state.connections;
    state.connections = { ...c, following: c.following.filter((u) => u.id !== id), mutual: c.mutual.filter((u) => u.id !== id) };
    return json(route, 200, { ok: true });
  });
  await page.route('**/api/follows', (route) => {
    const body = route.request().postDataJSON();
    state.posts.push(body);
    const u = [MEERA, RAVI, SITA].find((x) => x.id === body.userId);
    state.connections = { ...state.connections, following: [...state.connections.following, u], mutual: [...state.connections.mutual, u] };
    return json(route, 201, { ok: true });
  });
  await page.route('**/api/invites/*', (route) => {
    state.deletes.push(route.request().url());
    state.invites = state.invites.map((i) => (String(i.id) === route.request().url().split('/').pop() ? { ...i, state: 'revoked' } : i));
    return json(route, 200, { ok: true });
  });
  await page.route('**/api/invites', (route) => {
    if (route.request().method() === 'GET') return json(route, 200, { invites: state.invites });
    if (state.fail) return json(route, state.fail.status, { error: state.fail.error, field: 'email' });
    const { email } = route.request().postDataJSON();
    state.invites = [{ id: 77, email, state: 'open' }, ...state.invites];
    return json(route, 201, { invite: { id: 77, email }, link: LINK, whatsappUrl: `https://wa.me/?text=${encodeURIComponent('Asha invited you: ' + LINK)}`, remainingThisMonth: 4 });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/#/circle`, { waitUntil: 'load' });
  await page.waitForSelector('#view-circle:not([hidden]) #circle-lists');
  return { page, ctx, state };
}

test('three lists render with names, initials and no email or UPI', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    assert.equal(await page.locator('#circle-title').innerText(), 'Circle');
    assert.match(await page.locator('#circle-mutual').innerText(), /Meera Nair/);
    assert.match(await page.locator('#circle-following').innerText(), /Ravi Kumar/);
    assert.doesNotMatch(await page.locator('#circle-following').innerText(), /Meera/);
    assert.match(await page.locator('#circle-followers').innerText(), /Sita Devi/);
    assert.doesNotMatch(await page.locator('#circle-followers').innerText(), /Meera/);
    assert.equal(await page.locator('#circle-mutual .avatar').innerText(), 'MN');
    const headings = await page.locator('#circle h2').allInnerTexts();
    assert.deepEqual(headings.slice(0, 3), ['Mutual (1)', 'Following only (1)', 'Followers only (1)']);
    const html = await page.content();
    assert.doesNotMatch(html, /secret@example\.com|@okbank/);
  } finally { await ctx.close(); }
});

test('Follow back posts the userId and moves the person to Mutual', { skip }, async () => {
  const { page, ctx, state } = await open();
  try {
    const btn = page.getByRole('button', { name: 'Follow back Sita Devi' });
    assert.ok((await btn.boundingBox()).height >= 44);
    await btn.click();
    await page.waitForFunction(() => /Sita Devi/.test(document.querySelector('#circle-mutual')?.innerText || ''));
    assert.deepEqual(state.posts, [{ userId: 5 }]);
    assert.equal(await page.locator('[data-follow-back]').count(), 0);
  } finally { await ctx.close(); }
});

test('creating an invite shows WhatsApp and Copy link, and the link is never stored or in the URL or text', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.getByLabel('Email address to invite').fill('new.person@example.com');
    await page.getByRole('button', { name: 'Create invite' }).click();
    await page.waitForSelector('#wa-share');
    const href = await page.locator('#wa-share').getAttribute('href');
    assert.ok(href.startsWith('https://wa.me/?text='));
    assert.equal((await page.locator('#invites-left').innerText()), '4 invites left this month');
    await page.getByRole('button', { name: 'Copy link' }).click();
    await page.waitForFunction(() => /Link copied/.test(document.querySelector('#copy-status').innerText));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINK);
    const seen = await page.evaluate((t) => ({
      url: location.href.includes(t),
      local: JSON.stringify({ ...localStorage }).includes(t),
      session: JSON.stringify({ ...sessionStorage }).includes(t),
      text: document.body.innerText.includes(t),
    }), TOKEN);
    assert.deepEqual(seen, { url: false, local: false, session: false, text: false });
    const caches = await page.evaluate(async (t) => {
      let hit = false;
      for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) if (r.url.includes(t)) hit = true; }
      return hit;
    }, TOKEN);
    assert.equal(caches, false);
    // the new invite shows in My invites
    assert.match(await page.locator('#my-invites').innerText(), /new\.person@example\.com\s*Open/);
  } finally { await ctx.close(); }
});

test('my invites show state as text and Revoke only on open ones', { skip }, async () => {
  const invites = ['open', 'accepted', 'revoked', 'expired', 'superseded'].map((s, i) => ({ id: i + 1, email: `${s}@x.test`, state: s }));
  const { page, ctx, state } = await open({ invites });
  try {
    const rows = await page.locator('#my-invites li').allInnerTexts();
    assert.equal(rows.length, 5);
    ['Open', 'Accepted', 'Revoked', 'Expired', 'Superseded'].forEach((w, i) => assert.match(rows[i], new RegExp(w)));
    assert.equal(await page.locator('[data-revoke]').count(), 1);
    await page.getByRole('button', { name: /Revoke invite for open@x\.test/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-revoke]').length === 0);
    assert.match(state.deletes[0], /\/api\/invites\/1$/);
  } finally { await ctx.close(); }
});

test('409 and 429 messages are shown in the form', { skip }, async () => {
  for (const [status, error] of [[409, 'This person is already a member'], [429, 'You have used all your invites this month']]) {
    const { page, ctx } = await open({ fail: { status, error } });
    try {
      await page.getByLabel('Email address to invite').fill('a@b.test');
      await page.getByRole('button', { name: 'Create invite' }).click();
      await page.waitForFunction((m) => document.querySelector('#invite-error').innerText === m, error);
      assert.equal(await page.locator('#wa-share').count(), 0);
    } finally { await ctx.close(); }
  }
});

test('Unfollow asks first, Cancel sends nothing, Confirm sends DELETE and removes the entry', { skip }, async () => {
  const { page, ctx, state } = await open();
  try {
    await page.getByRole('button', { name: 'Unfollow Ravi Kumar' }).click();
    assert.match(await page.locator('#circle-following li').innerText(), /Unfollow Ravi Kumar\?/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(state.unfollows, undefined);
    assert.match(await page.locator('#circle-following').innerText(), /Ravi Kumar/);
    await page.getByRole('button', { name: 'Unfollow Ravi Kumar' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForFunction(() => !document.querySelector('#circle-following'));
    assert.deepEqual(state.unfollows, [{ method: 'DELETE', id: 4 }]);
    // a mutual entry can be unfollowed too
    await page.getByRole('button', { name: 'Unfollow Meera Nair' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForFunction(() => !document.querySelector('#circle-mutual'));
    assert.equal(state.unfollows[1].id, 3);
  } finally { await ctx.close(); }
});
