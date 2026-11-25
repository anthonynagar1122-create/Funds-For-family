'use strict';
// Audit regression tests: mobile navigation, tap targets, placeholder links, network and console health.
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

async function openAt(width, fn, { track } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(3000);
  const problems = [];
  if (track) {
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('requestfailed', (r) => problems.push(`failed request: ${r.url()}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  }
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    return await fn(page, problems);
  } finally { await ctx.close(); }
}

test('mobile 375 px: the primary navigation links are visible', { skip }, async () => {
  const visible = await openAt(375, (p) => p.evaluate(() => {
    const links = [...document.querySelectorAll('.header-nav a')];
    return links.map((a) => ({ text: a.textContent.trim(), shown: getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().width > 0 }));
  }));
  assert.ok(visible.length >= 3, 'nav has links');
  for (const l of visible) assert.ok(l.shown, `${l.text} is visible on mobile`);
});

test('mobile 375 px: every visible link and button is at least 44 px tall', { skip }, async () => {
  const small = await openAt(375, (p) => p.evaluate(() => {
    const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0; };
    return [...document.querySelectorAll('a[href], button, summary')]
      .filter((el) => shown(el) && !el.classList.contains('skip-link'))
      .map((el) => ({ text: (el.textContent || '').trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
      .filter((x) => x.h < 44);
  }));
  assert.deepEqual(small, [], `targets under 44 px: ${JSON.stringify(small)}`);
});

test('no placeholder contact address is published', { skip }, async () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /example\.(invalid|com)/, 'no example.* address on the landing page');
});

test('no console errors and no failed or 4xx/5xx requests while loading the landing page', { skip }, async () => {
  const problems = await openAt(1440, async (p, log) => {
    await p.waitForTimeout(300);
    return log;
  }, { track: true });
  assert.deepEqual(problems, []);
});

test('CSP: the landing page works under the production content security policy', { skip }, async () => {
  const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  try {
    const page = await ctx.newPage();
    const violations = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    // Serve the landing page with the same CSP that vercel.json sets for "/".
    await page.route(`http://127.0.0.1:${server.address().port}/`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.locator('#how-it-works').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const revealed = await page.evaluate(() => document.documentElement.classList.contains('js'));
    assert.equal(revealed, true, 'the page script ran under CSP');
    assert.deepEqual(violations, []);
  } finally { await ctx.close(); }
});
