'use strict';
// Visual regression for the landing page at mobile, tablet and desktop widths.
// Baselines are sha256 hashes of full-page screenshots in test/visual/. Missing baselines are created on first run.
// Set UPDATE_VISUAL=1 to regenerate them after an intentional visual change.
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
  test(`visual: landing matches its ${width} px baseline`, { skip }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    let png;
    try {
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      png = await page.screenshot({ fullPage: true, animations: 'disabled' });
    } finally { await ctx.close(); }

    const hash = crypto.createHash('sha256').update(png).digest('hex');
    const baseFile = path.join(BASE, `landing-${width}.sha256`);
    if (process.env.UPDATE_VISUAL === '1' || !fs.existsSync(baseFile)) {
      fs.mkdirSync(BASE, { recursive: true });
      fs.writeFileSync(baseFile, `${hash}\n`);
      return; // baseline written; the next run compares against it
    }
    const expected = fs.readFileSync(baseFile, 'utf8').trim();
    assert.equal(hash, expected, `${width} px screenshot changed; review, then run with UPDATE_VISUAL=1 if intentional`);
  });
}
