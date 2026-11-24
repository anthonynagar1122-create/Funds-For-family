'use strict';
// Browser test of the profile and statement pages with a MOCKED Clerk and MOCKED API.
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
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} async signOut(){ window.__signedOut = (window.__signedOut || 0) + 1; } };`;

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
const STATEMENT = {
  member: { id: 9, name: 'Asha Rao' }, generatedAt: '2026-11-24T10:00:00.000Z',
  requests: [{ requestId: 31, purpose: 'School <b>fees</b> for the second term', status: 'repaid', principalCents: 500000, repaymentDate: '2026-12-01',
    createdAt: '2026-10-01T00:00:00.000Z', raisedCents: 500000, paidBackCents: 500000,
    entries: [{ kind: 'contribution', id: 1, amountCents: 500000, status: 'confirmed', utr: '123456789012', createdAt: '2026-10-02T00:00:00.000Z' }] }],
  loans: [],
};

async function open(opts = {}, hash = '#/profile') {
  const state = { patches: [], prefs: [], helps: [], deletes: [], me: null, deleteResponse: { status: 200, body: { ok: true } }, ...opts };
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const user = { id: 9, name: 'Asha Rao', email: 'asha@example.com', upiId: 'asha@okbank', avatarUrl: null, isAdmin: false, emailReminders: true, emailThanks: false,
    welcomedAt: '2026-11-20T12:00:00.000Z', termsAcceptedAt: '2026-11-20T12:00:00.000Z', ...(opts.user || {}) };
  state.me = user;
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/config', (route) => json(route, 200, { clerkPublishableKey: 'pk_test_mock' }));
  await page.route('**/api/me', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      state.patches.push(body);
      if (state.patchError) return json(route, 400, state.patchError);
      Object.assign(state.me, body);
      return json(route, 200, { user: state.me });
    }
    if (route.request().method() === 'DELETE') {
      state.deletes.push(route.request().postDataJSON());
      return json(route, state.deleteResponse.status, state.deleteResponse.body);
    }
    return json(route, 200, { user: state.me });
  });
  await page.route('**/api/me/email-preferences', (route) => {
    const body = route.request().postDataJSON();
    state.prefs.push(body);
    state.me = { ...state.me, emailReminders: body.reminders, emailThanks: body.thanks };
    return json(route, 200, { user: state.me });
  });
  await page.route('**/api/me/statement', (route) => json(route, 200, STATEMENT));
  await page.route('**/api/users/9', (route) => json(route, 200, { user: { id: 9, name: 'Asha Rao',
    trust: { memberSince: '2026-03', repaidCount: 3, repaidOnTimeCount: 2, lentToCount: 5 } } }));
  await page.route('**/api/help', (route) => { state.helps.push(route.request().postDataJSON()); return json(route, 201, { ok: true }); });
  await page.route('**/api/home', (route) => json(route, 200, { needsYou: [], myRequests: [], myLending: [] }));
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  await page.waitForSelector('#view-profile:not([hidden]) h1');
  return { page, ctx, state };
}

test('sections render: initials, name, UPI, trust facts, statement link, help, delete, sign out', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.waitForSelector('#trust-list');
    assert.equal(await page.locator('#profile-who .avatar').innerText(), 'AR');
    assert.equal(await page.locator('#profile-name').innerText(), 'Asha Rao');
    assert.equal(await page.getByLabel('UPI ID').inputValue(), 'asha@okbank');
    const trust = await page.locator('#trust-list').innerText();
    assert.match(trust, /Member since March 2026/);
    assert.match(trust, /3 requests repaid/);
    assert.match(trust, /2 of those repaid by the agreed date/);
    assert.match(trust, /Lent to 5 requests/);
    assert.doesNotMatch(await page.locator('#view-profile').innerText(), /overdue|unpaid|nominee|interest/i);
    assert.equal(await page.locator('#statement-link').getAttribute('href'), '#/profile/statement');
    for (const name of ['Get help', 'Delete account', 'Email preferences', 'Trust history']) {
      assert.ok(await page.getByRole('heading', { name }).count(), name);
    }
    assert.ok(await page.getByRole('button', { name: 'Sign out' }).count());
    // 44 px targets
    for (const sel of ['#details-save', '#help-send', '#sign-out', '#statement-link', '#pref-reminders']) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box.height >= 24 && (sel === '#pref-reminders' || box.height >= 44), sel);
    }
    assert.ok((await page.locator('label[for="pref-reminders"]').boundingBox()).height >= 44);
  } finally { await ctx.close(); }
});

test('a photo is shown when the member has an https avatar', { skip }, async () => {
  const { page, ctx } = await open({ user: { avatarUrl: 'https://img.example.com/a.png' } });
  try {
    assert.equal(await page.locator('#profile-who img.avatar-photo').getAttribute('src'), 'https://img.example.com/a.png');
  } finally { await ctx.close(); }
});

test('saving details patches name and UPI; an error shows as text on the form', { skip }, async () => {
  const { page, ctx, state } = await open();
  try {
    await page.getByLabel('UPI ID').fill('asha2@okbank');
    await page.getByRole('button', { name: 'Save details' }).click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Saved');
    assert.deepEqual(state.patches.at(-1), { name: 'Asha Rao', upiId: 'asha2@okbank' });
    state.patchError = { error: 'Enter a valid UPI ID, like name@bank <script>x</script>', field: 'upiId' };
    await page.getByLabel('UPI ID').fill('bad');
    await page.getByRole('button', { name: 'Save details' }).click();
    await page.waitForFunction(() => /valid UPI/.test(document.querySelector('#details-error').textContent));
    assert.equal(await page.locator('#details-error script').count(), 0);
  } finally { await ctx.close(); }
});

test('email preferences: two toggles that save; essential emails are listed as always on, not toggles', { skip }, async () => {
  const { page, ctx, state } = await open();
  try {
    assert.equal(await page.getByLabel(/Reminders before/).isChecked(), true);
    assert.equal(await page.getByLabel(/Thank-you notes/).isChecked(), false);
    await page.getByLabel(/Thank-you notes/).check();
    await page.waitForFunction(() => document.querySelector('#prefs-status').textContent === 'Saved');
    assert.deepEqual(state.prefs.at(-1), { reminders: true, thanks: true });
    assert.equal(await page.locator('#email-prefs input[type=checkbox]').count(), 2);
    const essential = page.locator('#essential-emails');
    assert.equal(await essential.locator('input').count(), 0);
    assert.equal(await essential.locator('li').count(), 3);
    assert.equal(await essential.getByText('Always on').count(), 3);
  } finally { await ctx.close(); }
});

test('help form needs 10 characters and posts the body', { skip }, async () => {
  const { page, ctx, state } = await open();
  try {
    await page.getByLabel('How can we help?').fill('too short');
    await page.getByRole('button', { name: 'Send message' }).click();
    assert.match(await page.locator('#help-error').innerText(), /at least 10/);
    assert.equal(state.helps.length, 0);
    await page.getByLabel('How can we help?').fill('I cannot see my repayment entry');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.waitForFunction(() => /Thanks/.test(document.querySelector('#help-status').textContent));
    assert.deepEqual(state.helps, [{ body: 'I cannot see my repayment entry' }]);
  } finally { await ctx.close(); }
});

test('delete needs the typed word, shows the 409 reason as text, and signs out on success', { skip }, async () => {
  const reason = 'You have a request that is still active. <img src=x onerror=window.__x=1>';
  const { page, ctx, state } = await open({ deleteResponse: { status: 409, body: { error: reason } } });
  try {
    const go = page.getByRole('button', { name: 'Delete my account' });
    assert.equal(await go.isDisabled(), true);
    await page.getByLabel('Type DELETE to confirm').fill('delete');
    assert.equal(await go.isDisabled(), true);
    await page.getByLabel('Type DELETE to confirm').fill('DELETE');
    assert.equal(await go.isDisabled(), false);
    await go.click();
    await page.waitForFunction(() => /still active/.test(document.querySelector('#delete-error').textContent));
    assert.equal(await page.locator('#delete-error').innerText(), reason);
    assert.equal(await page.locator('#delete-error img').count(), 0);
    assert.deepEqual(state.deletes, [{ confirm: 'DELETE' }]);
    assert.equal(await page.evaluate(() => window.__signedOut || 0), 0);
    state.deleteResponse = { status: 200, body: { ok: true } };
    await go.click();
    await page.waitForFunction(() => window.__signedOut === 1);
    assert.equal(state.deletes.length, 2);
  } finally { await ctx.close(); }
});

test('sign out calls Clerk', { skip }, async () => {
  const { page, ctx } = await open();
  try {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForFunction(() => window.__signedOut === 1);
  } finally { await ctx.close(); }
});

test('statement renders a table, Print calls window.print, Share copies a text summary', { skip }, async () => {
  const { page, ctx } = await open({}, '#/profile/statement');
  try {
    await page.waitForSelector('#statement-heading');
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    const table = await page.locator('.stmt-table').innerText();
    assert.match(table, /₹5,000/);
    assert.match(table, /123456789012/);
    const html = await page.locator('#stmt-body').innerHTML();
    assert.doesNotMatch(html, /<b>fees<\/b>/);
    assert.match(await page.locator('#stmt-body').innerText(), /School <b>fees<\/b>/);
    await page.getByRole('button', { name: 'Print or save as PDF' }).click();
    assert.equal(await page.evaluate(() => window.__printed), 1);
    await page.getByRole('button', { name: 'Share summary' }).click();
    await page.waitForFunction(() => /copied/.test(document.querySelector('#stmt-status').textContent));
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /Funds For Family statement for Asha Rao/);
    assert.match(copied, /#31 repaid/);
    assert.ok((await page.getByRole('button', { name: 'Print or save as PDF' }).boundingBox()).height >= 44);
  } finally { await ctx.close(); }
});

test('Web Share is used when the browser has it', { skip }, async () => {
  const { page, ctx } = await open({}, '#/profile/statement');
  try {
    await page.waitForSelector('#statement-heading');
    await page.evaluate(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d; }; });
    await page.getByRole('button', { name: 'Share summary' }).click();
    await page.waitForFunction(() => window.__shared);
    assert.match(await page.evaluate(() => window.__shared.text), /Loans I made/);
  } finally { await ctx.close(); }
});
