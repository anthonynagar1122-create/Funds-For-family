'use strict';
// Visual regression for the signed-out screen at mobile, tablet and desktop widths.
// Baselines are sha256 hashes of full-page screenshots in test/visual/. A missing baseline skips the test (it is never invented).
// Screenshots depend on the machine's fonts, so baselines must be generated on the CI runner:
// run the "Update visual baselines" workflow (or UPDATE_VISUAL=1 locally for a local-only check).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const BASE = path.join(__dirname, 'visual');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const WIDTHS = [375, 768, 1440];
// Signed-out Clerk: no user, so the sign-in screen is shown.
const CLERK_SIGNED_OUT = `window.Clerk = class { constructor(){ this.user = null; }
  async load(){} addListener(){} mountUserButton(){} openSignIn(){} };`;
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';
let server = null;
let browser = null;

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

for (const width of WIDTHS) {
  test(`visual: sign-in screen matches its ${width} px baseline`, { skip }, async (t) => {
    const baseFile = path.join(BASE, `signin-${width}.sha256`);
    if (process.env.UPDATE_VISUAL !== '1' && !fs.existsSync(baseFile)) {
      // Never invent a baseline here: one made on another machine would not match CI.
      t.skip('no baseline yet: run the "Update visual baselines" workflow');
      return;
    }
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    let png;
    try {
      const page = await ctx.newPage();
      await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: CLERK_SIGNED_OUT }));
      await page.route('**/api/config', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ clerkPublishableKey: 'pk_test_mock' }) }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
      await page.waitForSelector('#signed-out:not([hidden])');
      await page.evaluate(() => document.fonts.ready);
      png = await page.screenshot({ fullPage: true, animations: 'disabled' });
    } finally { await ctx.close(); }

    const hash = crypto.createHash('sha256').update(png).digest('hex');
    if (process.env.UPDATE_VISUAL === '1') {
      fs.mkdirSync(BASE, { recursive: true });
      fs.writeFileSync(baseFile, `${hash}\n`);
      return; // baseline written; the next run compares against it
    }
    const expected = fs.readFileSync(baseFile, 'utf8').trim();
    assert.equal(hash, expected, `${width} px screenshot changed; review, then run the "Update visual baselines" workflow if intentional`);
  });
}
