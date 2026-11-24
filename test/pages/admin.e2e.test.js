'use strict';
// Browser test of the owner admin page with a MOCKED Clerk and MOCKED API.
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

async function open({ isAdmin = true, hash = '#/admin', fail = {} } = {}) {
  const calls = [];
  const data = {
    members: [
      { id: 2, name: 'Ben <i>Rao</i>', email: 'ben@example.com', isVerifier: false, inviteLimit: null, invitesThisMonth: 2 },
      { id: 3, name: 'Cara Das', email: 'cara@example.com', isVerifier: true, inviteLimit: 8, invitesThisMonth: 0 },
    ],
    invites: [
      { id: 11, email: 'new@example.com', inviterName: 'Ben <i>Rao</i>', state: 'open', createdAt: '2026-11-20T00:00:00.000Z', expiresAt: '2026-12-04T00:00:00.000Z' },
      { id: 12, email: 'old@example.com', joinedEmail: 'other@example.com', inviterName: 'Cara Das', state: 'accepted', createdAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z' },
    ],
    help: [{ id: 21, body: 'My <b>UPI</b> will not save', createdAt: '2026-11-22T00:00:00.000Z', resolvedAt: null, userId: 2, name: 'Ben <i>Rao</i>', email: 'ben@example.com' }],
    stuck: [
      { kind: 'contribution', id: 31, requestId: 5, amountCents: 250000, status: 'sent', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: null, daysWaiting: 9, payerName: 'Cara Das', receiverName: 'Ben <i>Rao</i>', isYours: false },
      { kind: 'repayment', id: 32, requestId: 5, amountCents: 100000, status: 'not_received', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: null, daysWaiting: 12, payerName: 'Ben <i>Rao</i>', receiverName: 'Cara Das', isYours: false },
    ],
    gaps: [{ requestId: 5, borrowerName: 'Ben <i>Rao</i>', purpose: 'School fees', eligibleVerifiers: 1, needed: 2 }],
    stats: { invitesSent: 12, invitesAccepted: 7, acceptedWhoMadeOrFunded: 4 },
  };
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => json(route, 200, { user: { id: 1, name: 'Owner', email: 'boss@example.com', isAdmin,
    welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z' } }));
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.route('**/api/admin/**', (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace('/api/admin', '');
    const body = req.method() === 'GET' ? null : req.postDataJSON();
    calls.push({ method: req.method(), path: p, body });
    const key = `${req.method()} ${p}`;
    if (fail[key]) return json(route, fail[key].status, fail[key].body);
    if (key === 'GET /members') return json(route, 200, { members: data.members });
    if (key === 'GET /invites') return json(route, 200, { invites: data.invites });
    if (key === 'GET /help-messages') return json(route, 200, { messages: data.help });
    if (key === 'GET /stuck') return json(route, 200, { entries: data.stuck });
    if (key === 'GET /verification-gaps') return json(route, 200, { requests: data.gaps });
    if (key === 'GET /stats') return json(route, 200, data.stats);
    if (/^POST \/members\/\d+\/verifier$/.test(key)) return json(route, 200, { member: { ...data.members[0], isVerifier: body.on } });
    if (/^POST \/members\/\d+\/invite-limit$/.test(key)) return json(route, 200, { member: { ...data.members[0], inviteLimit: body.limit } });
    if (/^DELETE \/invites\/\d+$/.test(key)) return json(route, 200, { invite: { id: 11, state: 'revoked' } });
    if (/^POST \/help-messages\/\d+\/resolve$/.test(key)) return json(route, 200, { message: { ...data.help[0], resolvedAt: '2026-11-24T00:00:00.000Z' } });
    if (/^POST \/(contributions|repayments)\/\d+\/settle$/.test(key)) return json(route, 200, { ok: true });
    return json(route, 404, { error: 'unmocked' });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  return { page, ctx, calls, data };
}

const status = (page) => page.locator('#admin-status');
const waitStatus = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('#admin-status')?.textContent || ''), re.source);

test('a member who opens #/admin sees no admin page and no Admin tab', { skip }, async () => {
  const { page, ctx, calls } = await open({ isAdmin: false });
  try {
    await page.waitForSelector('#view-home:not([hidden])');
    assert.equal(await page.locator('#admin').count() ? await page.locator('#view-admin').isVisible() : false, false);
    assert.equal(await page.getByRole('heading', { name: 'Admin' }).count(), 0);
    assert.equal(await page.locator('nav a', { hasText: 'Admin' }).count(), 0);
    assert.equal(calls.length, 0, 'no admin API call is made');
  } finally { await ctx.close(); }
});

test('an admin sees the six tabs in order and a single h1, with tabs at 44 px', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#view-admin:not([hidden]) h1');
    assert.equal(await page.locator('#view-admin h1').innerText(), 'Admin');
    const tabs = await page.getByRole('tab').allInnerTexts();
    assert.deepEqual(tabs, ['Members', 'Invites', 'Help', 'Stuck', 'Gaps', 'Stats']);
    for (const t of await page.getByRole('tab').all()) assert.ok((await t.boundingBox()).height >= 44);
    assert.equal(await page.locator('#view-admin h1').count(), 1);
    assert.equal(await page.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected'), 'true');
  } finally { await ctx.close(); }
});

test('members: names are escaped, verifier toggle and invite limit save with a text result', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.waitForSelector('#admin-panel li');
    assert.equal(await page.locator('#admin-panel i').count(), 0, 'no markup from names');
    assert.match(await page.locator('#admin-panel').innerText(), /ben@example\.com/);
    await page.getByRole('button', { name: /Make Ben <i>Rao<\/i> a verifier/ }).click();
    await waitStatus(page, /Ben <i>Rao<\/i> is now a verifier/);
    assert.deepEqual(calls.find((c) => c.path === '/members/2/verifier').body, { on: true });
    await page.getByLabel(/Invite limit for Ben/).fill('12');
    await page.getByRole('button', { name: /Save invite limit for Ben/ }).click();
    await waitStatus(page, /Invite limit for Ben <i>Rao<\/i> saved: 12/);
    assert.deepEqual(calls.find((c) => c.path === '/members/2/invite-limit').body, { limit: 12 });
    await page.getByLabel(/Invite limit for Ben/).fill('');
    await page.getByRole('button', { name: /Save invite limit for Ben/ }).click();
    await waitStatus(page, /reset to the default/);
    assert.deepEqual(calls.filter((c) => c.path === '/members/2/invite-limit').at(-1).body, { limit: null });
    assert.equal(await status(page).getAttribute('role'), 'status');
  } finally { await ctx.close(); }
});

test('members: a server error shows as text and a bad limit is caught before sending', { skip }, async () => {
  const { page, ctx, calls } = await open({ fail: { 'POST /members/3/verifier': { status: 409, body: { error: 'You cannot remove your own verifier status' } } } });
  try {
    await page.waitForSelector('#admin-panel li');
    await page.getByRole('button', { name: /Remove Cara Das as a verifier/ }).click();
    await waitStatus(page, /cannot remove your own verifier status/);
    await page.getByLabel(/Invite limit for Cara/).fill('99');
    await page.getByRole('button', { name: /Save invite limit for Cara/ }).click();
    await waitStatus(page, /whole number from 0 to 50/);
    assert.equal(calls.some((c) => c.path === '/members/3/invite-limit'), false);
  } finally { await ctx.close(); }
});

test('invites: state shown as text, Revoke only for open, result as text', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.getByRole('tab', { name: 'Invites' }).click();
    await page.waitForSelector('#admin-panel li');
    const text = await page.locator('#admin-panel').innerText();
    assert.match(text, /new@example\.com/);
    assert.match(text, /Open/);
    assert.match(text, /Accepted/);
    assert.match(text, /Joined with other@example\.com/);
    assert.match(text, /different from the invited address/i);
    assert.equal(await page.getByRole('button', { name: /Revoke invite/ }).count(), 1);
    await page.getByRole('button', { name: 'Revoke invite for new@example.com' }).click();
    await waitStatus(page, /Invite for new@example\.com revoked/);
    assert.equal(calls.some((c) => c.method === 'DELETE' && c.path === '/invites/11'), true);
  } finally { await ctx.close(); }
});

test('help: unresolved messages escaped; Mark resolved shows a text result', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.getByRole('tab', { name: 'Help' }).click();
    await page.waitForSelector('#admin-panel li');
    assert.equal(await page.locator('#admin-panel b, #admin-panel i').count(), 0);
    assert.match(await page.locator('#admin-panel').innerText(), /My <b>UPI<\/b> will not save/);
    await page.getByRole('button', { name: /Mark message from Ben .* resolved/ }).click();
    await waitStatus(page, /Marked as resolved/);
    assert.ok(calls.some((c) => c.path === '/help-messages/21/resolve'));
    assert.equal(await page.locator('#admin-panel li').count(), 0, 'resolved message leaves the list');
  } finally { await ctx.close(); }
});

test('stuck: confirm and remove need a note, send it, and report the result as text', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.getByRole('tab', { name: 'Stuck' }).click();
    await page.waitForSelector('#admin-panel li');
    const text = await page.locator('#admin-panel').innerText();
    assert.match(text, /₹2,500/);
    assert.match(text, /9 days/);
    await page.getByRole('button', { name: 'Confirm contribution 31 as received' }).click();
    await waitStatus(page, /Write a note of 5 to 500 characters/);
    assert.equal(calls.some((c) => c.path.includes('settle')), false);
    await page.getByLabel('Note for contribution 31').fill('Borrower confirmed by phone');
    await page.getByRole('button', { name: 'Confirm contribution 31 as received' }).click();
    await waitStatus(page, /Contribution 31 confirmed/);
    assert.deepEqual(calls.find((c) => c.path === '/contributions/31/settle').body, { action: 'confirm', note: 'Borrower confirmed by phone' });
    await page.getByLabel('Note for repayment 32').fill('Payer says it never went');
    await page.getByRole('button', { name: 'Remove repayment 32' }).click();
    await waitStatus(page, /Repayment 32 removed/);
    assert.deepEqual(calls.find((c) => c.path === '/repayments/32/settle').body, { action: 'remove', note: 'Payer says it never went' });
    assert.equal(await page.locator('#admin-panel li').count(), 0);
  } finally { await ctx.close(); }
});

test('stuck: a 409 from the server shows as text and keeps the entry', { skip }, async () => {
  const { page, ctx } = await open({ fail: { 'POST /contributions/31/settle': { status: 409, body: { error: 'This entry is not old enough to settle' } } } });
  try {
    await page.getByRole('tab', { name: 'Stuck' }).click();
    await page.waitForSelector('#admin-panel li');
    await page.getByLabel('Note for contribution 31').fill('Borrower confirmed by phone');
    await page.getByRole('button', { name: 'Confirm contribution 31 as received' }).click();
    await waitStatus(page, /not old enough to settle/);
    assert.equal(await page.locator('#admin-panel li').count(), 2);
  } finally { await ctx.close(); }
});

test('gaps and stats tabs show their data as text', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.getByRole('tab', { name: 'Gaps' }).click();
    await page.waitForSelector('#admin-panel li');
    const gaps = await page.locator('#admin-panel').innerText();
    assert.match(gaps, /Ben <i>Rao<\/i>/);
    assert.match(gaps, /Needs another verifier/);
    assert.match(gaps, /1 of 2/);
    assert.equal(await page.locator('#admin-panel i').count(), 0);
    await page.getByRole('tab', { name: 'Stats' }).click();
    await page.waitForSelector('#stat-sent');
    assert.equal(await page.locator('#stat-sent').innerText(), '12');
    assert.equal(await page.locator('#stat-accepted').innerText(), '7');
    assert.equal(await page.locator('#stat-acted').innerText(), '4');
    const t = await page.locator('#admin-panel').innerText();
    assert.match(t, /Invites sent/);
    assert.match(t, /Invites accepted/);
    assert.match(t, /made or funded a request/);
  } finally { await ctx.close(); }
});

test('a tab that fails to load shows an error as text', { skip }, async () => {
  const { page, ctx } = await open({ fail: { 'GET /stats': { status: 500, body: { error: 'Something went wrong' } } } });
  try {
    await page.getByRole('tab', { name: 'Stats' }).click();
    await waitStatus(page, /Could not load.*Something went wrong/);
  } finally { await ctx.close(); }
});

test('leaving the admin page and coming back does not multiply click handlers', { skip }, async () => {
  const { page, ctx, calls } = await open();
  try {
    await page.waitForSelector('#admin-panel li');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { location.hash = '#/home'; });
      await page.waitForSelector('#view-home:not([hidden])');
      await page.evaluate(() => { location.hash = '#/admin'; });
      await page.waitForSelector('#view-admin:not([hidden]) #admin-panel li');
    }
    const before = calls.filter((c) => c.path === '/invites').length;
    await page.getByRole('tab', { name: 'Invites' }).click();
    await page.waitForSelector('#admin-panel button[data-act="revoke"]');
    assert.equal(calls.filter((c) => c.path === '/invites').length - before, 1, 'exactly one request for one click');
  } finally { await ctx.close(); }
});
