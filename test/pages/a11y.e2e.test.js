'use strict';
// Page-level accessibility and layout checks across the main routes at 320 and 375 px, plus colour contrast of
// the design tokens. MOCKED Clerk and MOCKED API (one catch-all handler), no new dependency.
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
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} async signOut(){} };`;
const STAMP = '2026-11-20T12:00:00.000Z';

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

const NAMES = { 1: 'Ann Rao', 2: 'Tess Kumar', 5: 'Lena Shah', 9: 'Asha Rao' };
const REQUEST = {
  id: 1, borrowerId: 1, trustedContactId: 2, purpose: 'School fees for the second term', principalCents: 200000, repaymentDate: '2027-03-01',
  status: 'open', raisedCents: 50000, remainingCents: 150000, totals: { confirmedCents: 50000, pendingCents: 0 },
  lenders: [{ userId: 5, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }],
  payTo: [{ userId: 1, name: 'Ann Rao', upiId: 'ann@okbank' }], daysOverdue: 0, verifications: [],
  contributions: [{ id: 12, contributorId: 5, amountCents: 50000, utr: null, status: 'confirmed', createdAt: '2027-01-02T10:00:00.000Z', confirmedAt: '2027-01-03T10:00:00.000Z' }], repayments: [],
};
const HOME = {
  needsYou: [{ kind: 'verify', requestId: 8, otherName: 'Dev Patel' }],
  myRequests: [{ id: 1, borrowerId: 9, trustedContactId: 2, purpose: 'School fees', principalCents: 1000000, status: 'open', repaymentDate: '2027-03-01', totals: { confirmedCents: 250000, pendingCents: 100000 } }],
  myLending: [{ id: 4, borrowerId: 1, purpose: 'Bike repair', status: 'funded', myLentCents: 300000, myRepaidCents: 50000, myOwedCents: 250000 }],
};
const PEOPLE = [{ id: 3, name: 'Meera Nair', email: 'm@example.com', upiId: 'm@okbank' }, { id: 5, name: 'Lena Shah', email: 'l@example.com', upiId: 'l@okbank' }];
const ADMIN = {
  members: [{ id: 2, name: 'Ben Rao', email: 'ben@example.com', isVerifier: false, inviteLimit: null, invitesThisMonth: 2 }],
  invites: [{ id: 11, email: 'new@example.com', inviterName: 'Ben Rao', state: 'open', createdAt: '2026-11-20T00:00:00.000Z', expiresAt: '2026-12-04T00:00:00.000Z' }],
  help: [{ id: 21, body: 'My UPI will not save', createdAt: '2026-11-22T00:00:00.000Z', resolvedAt: null, userId: 2, name: 'Ben Rao', email: 'ben@example.com' }],
  stuck: [{ kind: 'contribution', id: 31, requestId: 5, amountCents: 250000, status: 'sent', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: null, daysWaiting: 9, payerName: 'Cara Das', receiverName: 'Ben Rao', isYours: false }],
  gaps: [{ requestId: 5, borrowerName: 'Ben Rao', purpose: 'School fees', eligibleVerifiers: 1, needed: 2 }],
};

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openRoute(hash, width, { welcomed = true, admin = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const user = { id: 9, name: 'Asha Rao', email: 'asha@example.com', upiId: 'asha@okbank', avatarUrl: null, isAdmin: admin, emailReminders: true, emailThanks: true,
    welcomedAt: welcomed ? STAMP : null, termsAcceptedAt: welcomed ? STAMP : null, inviterName: 'Ann Rao' };
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    if (route.request().method() !== 'GET') return json(route, { user, ok: true });
    if (p === '/config') return json(route, { clerkPublishableKey: 'pk_test_mock' });
    if (p === '/me') return json(route, { user });
    if (p === '/home') return json(route, HOME);
    if (p === '/feed') return json(route, { requests: [] });
    if (p === '/activity') return json(route, { borrowing: [], lending: [], repayments: { made: [], received: [] }, roles: { trustedContact: [], verifier: [] } });
    if (p === '/users') return json(route, { users: PEOPLE });
    if (/^\/users\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      return json(route, { user: { id, name: NAMES[id] || 'Member', trust: { memberSince: '2026-03', repaidCount: 3, repaidOnTimeCount: 2, lentToCount: 5 } } });
    }
    if (p === '/requests/1') return json(route, { request: REQUEST });
    if (p === '/connections') return json(route, { following: PEOPLE, followers: PEOPLE, mutual: [PEOPLE[0]] });
    if (p === '/invites') return json(route, { invites: [] });
    if (p === '/help/mine') return json(route, { messages: [] });
    if (p === '/admin/members') return json(route, { members: ADMIN.members });
    if (p === '/admin/invites') return json(route, { invites: ADMIN.invites });
    if (p === '/admin/help-messages') return json(route, { messages: ADMIN.help });
    if (p === '/admin/stuck') return json(route, { entries: ADMIN.stuck });
    if (p === '/admin/verification-gaps') return json(route, { requests: ADMIN.gaps });
    if (p === '/admin/stats') return json(route, { invitesSent: 12, invitesAccepted: 7, acceptedWhoMadeOrFunded: 4 });
    return json(route, { error: 'unmocked' }, 404);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/app/${hash}`, { waitUntil: 'load' });
  return { page, ctx };
}

const ROUTES = [
  { name: 'home', hash: '#/home', ready: '#home-title' },
  { name: 'new', hash: '#/new', ready: '#new-title' },
  { name: 'request', hash: '#/request/1', ready: '#detail h1' },
  { name: 'circle', hash: '#/circle', ready: '#circle-title' },
  { name: 'profile', hash: '#/profile', ready: '#profile-heading' },
  { name: 'admin', hash: '#/admin', ready: '#admin-heading', opts: { admin: true } },
  { name: 'welcome', hash: '#/welcome', ready: '#welcome-title', opts: { welcomed: false } },
  { name: 'terms', hash: '#/terms', ready: '#legal-heading' },
  { name: 'privacy', hash: '#/privacy', ready: '#legal-heading' },
];

// Runs in the page. Returns problems found in the visible view.
function audit() {
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
  const problems = [];
  const h1s = [...document.querySelectorAll('h1')].filter(visible);
  if (h1s.length !== 1) problems.push(`expected one visible h1, found ${h1s.length}`);
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest('label');
    return wrap ? wrap.textContent.trim() : '';
  };
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!visible(el) || ['hidden', 'submit', 'button'].includes(el.type)) continue;
    if (!nameOf(el)) problems.push(`unlabelled control ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);
  }
  for (const el of document.querySelectorAll('button, a.btn, [role="button"]')) {
    if (!visible(el)) continue;
    if (!(el.textContent.trim() || el.getAttribute('aria-label'))) problems.push(`button without a name: ${el.outerHTML.slice(0, 80)}`);
  }
  if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`horizontal scroll: ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  const small = (el, what) => { const r = el.getBoundingClientRect(); if (r.height < 43.5 || r.width < 43.5) problems.push(`${what} is ${Math.round(r.width)}x${Math.round(r.height)}: ${(el.textContent || '').trim().slice(0, 30)}`); };
  const nav = document.getElementById('primary-nav');
  if (nav && !nav.hidden) for (const a of nav.querySelectorAll('a')) small(a, 'tab');
  for (const b of document.querySelectorAll('.btn-primary')) if (visible(b)) small(b, 'primary button');
  return problems;
}

for (const width of [320, 375]) {
  for (const r of ROUTES) {
    test(`a11y ${r.name} at ${width}px: one h1, labelled controls, named buttons, no sideways scroll, 44px targets`, { skip }, async () => {
      const { page, ctx } = await openRoute(r.hash, width, r.opts);
      try {
        await page.waitForSelector(r.ready, { state: 'visible' });
        await page.waitForTimeout(150); // let a late render settle (trust list, admin sections)
        assert.deepEqual(await page.evaluate(audit), []);
      } finally { await ctx.close(); }
    });
  }
}

test('a toast on a phone sits above the bottom tab bar and the last content is not hidden behind it', { skip }, async () => {
  const { page, ctx } = await openRoute('#/home', 375);
  try {
    await page.waitForSelector('#home-title', { state: 'visible' });
    await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = 'Saved'; t.hidden = false; });
    const { toast, nav, bodyPad } = await page.evaluate(() => ({
      toast: document.getElementById('toast').getBoundingClientRect().toJSON(),
      nav: document.getElementById('primary-nav').getBoundingClientRect().toJSON(),
      bodyPad: parseFloat(getComputedStyle(document.body).paddingBottom),
    }));
    assert.ok(toast.bottom <= nav.top, `toast bottom ${toast.bottom} overlaps the tab bar top ${nav.top}`);
    assert.ok(bodyPad >= nav.height, `body bottom padding ${bodyPad} is less than the tab bar height ${nav.height}`);
  } finally { await ctx.close(); }
});

// ---- Contrast of the design tokens (no browser needed) ----
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  assert.ok(m, `token --${name}`);
  return m[1];
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('contrast: text tokens meet 4.5:1 on the surfaces they sit on', () => {
  const surface = token('color-surface'); const canvas = token('color-canvas'); const brand100 = token('color-brand-100');
  const pairs = [
    ['ink-900 on canvas', token('color-ink-900'), canvas], ['ink-900 on surface', token('color-ink-900'), surface],
    ['ink-700 on canvas', token('color-ink-700'), canvas], ['ink-700 on surface', token('color-ink-700'), surface],
    ['ink-500 (muted) on canvas', token('color-ink-500'), canvas], ['ink-500 (muted) on surface', token('color-ink-500'), surface],
    ['brand-700 (links) on canvas', token('color-brand-700'), canvas], ['brand-700 (links) on surface', token('color-brand-700'), surface],
    ['brand-700 on brand-100 (active tab, badge)', token('color-brand-700'), brand100],
    ['white on brand-600 (primary button)', '#ffffff', token('color-brand-600')], ['white on brand-700 (hover)', '#ffffff', token('color-brand-700')],
    ['danger-700 on surface', token('color-danger-700'), surface], ['danger-700 on canvas', token('color-danger-700'), canvas],
    ['success-700 on brand-100 (badge)', token('color-success-700'), brand100], ['white on ink-900 (toast)', '#ffffff', token('color-ink-900')],
    ['warn badge text on its background', '#7a4d00', '#fdf0d5'], ['danger badge text on its background', token('color-danger-700'), '#fbe4e4'],
  ];
  for (const [label, fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${label}: ${ratio(fg, bg).toFixed(2)}:1`);
});
