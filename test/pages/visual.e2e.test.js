'use strict';
// Visual regression for the home and request pages at phone, tablet and desktop widths.
// Baselines: test/visual/phase-b-<page>-<width>.sha256 (sha256 of a full-page screenshot). Missing baselines are
// created on first run; UPDATE_VISUAL=1 regenerates them after an intentional change. Review the screenshots first:
// set VISUAL_PNG_DIR=<dir> to also write the PNGs there.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const BASE = path.join(__dirname, '..', 'visual');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const WIDTHS = [375, 768, 1440];
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';
let server = null;
let browser = null;

const CLERK_STUB = `window.Clerk = class { constructor(){ this.user = { id: 'mock' }; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} };`;
const STAMP = '2026-11-20T12:00:00.000Z';
const NAMES = { 1: 'Ann Rao', 2: 'Tess Kumar', 5: 'Lena Shah', 9: 'Asha Rao' };
const USER = { id: 9, name: 'Asha Rao', email: 'asha@example.com', upiId: 'asha@okbank', avatarUrl: null, isAdmin: false, welcomedAt: STAMP, termsAcceptedAt: STAMP };
const HOME = {
  needsYou: [{ kind: 'confirm_contribution', requestId: 1, otherName: 'Lena Shah', amountCents: 2500000 }, { kind: 'verify', requestId: 8, otherName: 'Dev Patel' }],
  myRequests: [{ id: 1, borrowerId: 9, trustedContactId: 2, purpose: 'School fees for the second term', principalCents: 1000000, status: 'open', repaymentDate: '2027-03-01', totals: { confirmedCents: 250000, pendingCents: 100000 } }],
  myLending: [{ id: 4, borrowerId: 1, purpose: 'Bike repair', status: 'funded', myLentCents: 300000, myRepaidCents: 50000, myOwedCents: 250000 }],
};
const REQUEST = {
  id: 1, borrowerId: 1, trustedContactId: 2, purpose: 'School fees for the second term', principalCents: 200000, repaymentDate: '2027-03-01',
  status: 'open', raisedCents: 50000, remainingCents: 150000, totals: { confirmedCents: 50000, pendingCents: 20000 },
  lenders: [{ userId: 5, lentCents: 50000, repaidCents: 0, pendingRepayCents: 0, owedCents: 50000 }],
  payTo: [{ userId: 1, name: 'Ann Rao', upiId: 'ann@okbank' }], daysOverdue: 0, verifications: [],
  contributions: [
    { id: 11, contributorId: 5, amountCents: 20000, utr: 'UTR123456', status: 'sent', createdAt: '2027-01-05T10:00:00.000Z', confirmedAt: null },
    { id: 12, contributorId: 5, amountCents: 50000, utr: null, status: 'confirmed', createdAt: '2027-01-02T10:00:00.000Z', confirmedAt: '2027-01-03T10:00:00.000Z' },
  ], repayments: [],
};
const PAGES = [
  { name: 'home', hash: '#/home', ready: '#needs-list' },
  { name: 'request', hash: '#/request/1', ready: '#detail h1' },
];

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

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

for (const pg of PAGES) {
  for (const width of WIDTHS) {
    test(`visual: ${pg.name} page matches its ${width} px baseline`, { skip }, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
      let png;
      try {
        const page = await ctx.newPage();
        await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: CLERK_STUB }));
        await page.route('**/api/**', (route) => {
          const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
          if (p === '/config') return json(route, { clerkPublishableKey: 'pk_test_mock' });
          if (p === '/me') return json(route, { user: USER });
          if (p === '/home') return json(route, HOME);
          if (/^\/users\/\d+$/.test(p)) { const id = Number(p.split('/').pop()); return json(route, { user: { id, name: NAMES[id] || 'Member' } }); }
          if (p === '/requests/1') return json(route, { request: REQUEST });
          return json(route, { error: 'unmocked' }, 404);
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/app/${pg.hash}`, { waitUntil: 'load' });
        await page.waitForSelector(pg.ready, { state: 'visible' });
        await page.waitForTimeout(200);
        await page.evaluate(() => document.fonts.ready);
        png = await page.screenshot({ fullPage: true, animations: 'disabled' });
      } finally { await ctx.close(); }

      if (process.env.VISUAL_PNG_DIR) {
        fs.mkdirSync(process.env.VISUAL_PNG_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.VISUAL_PNG_DIR, `phase-b-${pg.name}-${width}.png`), png);
      }
      const hash = crypto.createHash('sha256').update(png).digest('hex');
      const baseFile = path.join(BASE, `phase-b-${pg.name}-${width}.sha256`);
      if (process.env.UPDATE_VISUAL === '1' || !fs.existsSync(baseFile)) {
        fs.mkdirSync(BASE, { recursive: true });
        fs.writeFileSync(baseFile, `${hash}\n`);
        return;
      }
      assert.equal(hash, fs.readFileSync(baseFile, 'utf8').trim(), `${pg.name} ${width} px screenshot changed; review, then run with UPDATE_VISUAL=1 if intentional`);
    });
  }
}
