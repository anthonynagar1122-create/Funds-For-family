'use strict';
// Interaction tests for the landing page: keyboard, focus, FAQ, and layout at tablet width.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
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

async function withPage({ width = 1440, reducedMotion = 'reduce' } = {}, fn) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    return await fn(page);
  } finally { await ctx.close(); }
}

test('keyboard: Tab from the top visits the skip link, the brand, then the header links', { skip }, async () => {
  const order = await withPage({}, async (p) => {
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await p.keyboard.press('Tab');
      // Accessible name: aria-label if set, otherwise the text without decorative (aria-hidden) icons.
      seen.push(await p.evaluate(() => {
        const el = document.activeElement;
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
        return clone.textContent.trim();
      }));
    }
    return seen;
  });
  assert.deepEqual(order, ['Skip to content', 'Funds For Family home', 'How it works']);
});

test('focus: keyboard focus on the primary CTA shows a visible ring', { skip }, async () => {
  const outline = await withPage({}, async (p) => {
    const btn = p.locator('.hero .btn-primary');
    await btn.focus();
    await p.keyboard.press('Shift+Tab');
    await p.keyboard.press('Tab');
    return btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    });
  });
  assert.notEqual(outline.style, 'none', 'outline visible on keyboard focus');
  assert.equal(outline.width, '3px');
});

test('FAQ: Enter on a question opens its answer', { skip }, async () => {
  const open = await withPage({}, async (p) => {
    const summary = p.locator('.faq summary').first();
    await summary.focus();
    await p.keyboard.press('Enter');
    return p.locator('.faq details').first().evaluate((el) => el.open);
  });
  assert.equal(open, true);
});

test('FAQ: a question answers with the same keyboard action again to close', { skip }, async () => {
  const open = await withPage({}, async (p) => {
    const summary = p.locator('.faq summary').first();
    await summary.focus();
    await p.keyboard.press('Enter');
    await p.keyboard.press('Enter');
    return p.locator('.faq details').first().evaluate((el) => el.open);
  });
  assert.equal(open, false);
});

test('tablet 768 px: steps lay out in two columns and the example card keeps its accent', { skip }, async () => {
  const r = await withPage({ width: 768 }, (p) => p.evaluate(() => {
    const cols = getComputedStyle(document.querySelector('.steps')).gridTemplateColumns.split(' ').length;
    const accent = getComputedStyle(document.querySelector('.example-card'), '::before').height;
    return { cols, accent };
  }));
  assert.equal(r.cols, 2);
  assert.equal(r.accent, '3px');
});

test('tablet 768 px: no horizontal overflow', { skip }, async () => {
  const overflow = await withPage({ width: 768 }, (p) => p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth));
  assert.equal(overflow, 0);
});

test('reduced motion: the FAQ chevron does not animate', { skip }, async () => {
  const d = await withPage({ reducedMotion: 'reduce' }, (p) => p.evaluate(() =>
    getComputedStyle(document.querySelector('.faq summary'), '::after').transitionDuration));
  assert.ok(d.split(',').every((x) => parseFloat(x) === 0), `duration ${d}`);
});
