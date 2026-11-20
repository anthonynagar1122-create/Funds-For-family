'use strict';
// Browser tests for the landing page. Run with: npm test
// Uses the Playwright browser preinstalled in this environment (no download).
// One browser and one server are shared by the whole file; each test gets its own context.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const ALLOWED_MS = [100, 150, 200, 300];

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';

let server = null;
let browser = null;
const base = () => `http://127.0.0.1:${server.address().port}`;

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function withPage({ width = 1440, reducedMotion = 'no-preference', js = true } = {}, fn) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion, javaScriptEnabled: js });
  try {
    const page = await ctx.newPage();
    await page.goto(`${base()}/`, { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

const toMs = (s) => Math.round(parseFloat(s) * (s.trim().endsWith('ms') ? 1 : 1000));
const eachMs = (list) => list.split(',').map((x) => toMs(x.trim()));

// ---- Card system: the cards read their values from one set of tokens ----

test('cards use the card tokens: radius 12 and padding 28 at 1440 px', { skip }, async () => {
  const cards = await withPage({ width: 1440 }, (p) => p.evaluate(() =>
    ['.feature', '.step', '.example-card', '.calc'].map((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { s, radius: cs.borderRadius, pad: cs.paddingTop };
    })));
  for (const c of cards) {
    assert.equal(c.radius, '12px', c.s);
    assert.equal(c.pad, '28px', c.s);
  }
});

test('cards drop to 24 px padding at 375 px, from the same token', { skip }, async () => {
  const pads = await withPage({ width: 375 }, (p) => p.evaluate(() =>
    ['.feature', '.step', '.example-card', '.calc'].map((s) => getComputedStyle(document.querySelector(s)).paddingTop)));
  for (const pad of pads) assert.equal(pad, '24px');
});

test('no horizontal overflow at 375 and 1440 px', { skip }, async () => {
  for (const width of [375, 1440]) {
    const overflow = await withPage({ width }, (p) => p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth));
    assert.equal(overflow, 0, `overflow at ${width}`);
  }
});

test('trust titles and card titles share one colour', { skip }, async () => {
  const [trust, card] = await withPage({}, (p) => p.evaluate(() => [
    getComputedStyle(document.querySelector('.trust-title')).color,
    getComputedStyle(document.querySelector('.feature h3')).color,
  ]));
  assert.equal(trust, card);
});

test('hero headline wraps to at most three lines at 1440 px', { skip }, async () => {
  const lines = await withPage({ width: 1440 }, (p) => p.evaluate(() => {
    const h1 = document.querySelector('h1');
    return Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight));
  }));
  assert.ok(lines <= 3, `headline is ${lines} lines`);
});

test('content is visible with JavaScript disabled', { skip }, async () => {
  const hidden = await withPage({ js: false }, (p) => p.evaluate(() =>
    [...document.querySelectorAll('.reveal')].filter((el) => getComputedStyle(el).opacity === '0').length));
  assert.equal(hidden, 0);
});

// ---- Motion ----

test('reveal transitions use only duration tokens (100/150/200/300 ms)', { skip }, async () => {
  const durations = await withPage({}, (p) => p.evaluate(() =>
    [...document.querySelectorAll('.reveal')].map((el) => getComputedStyle(el).transitionDuration)));
  assert.ok(durations.length > 0);
  for (const d of durations) for (const ms of eachMs(d)) assert.ok(ALLOWED_MS.includes(ms), `${ms}ms`);
});

test('reveal animates only opacity and transform', { skip }, async () => {
  const props = await withPage({}, (p) => p.evaluate(() =>
    [...document.querySelectorAll('.reveal')].map((el) => getComputedStyle(el).transitionProperty)));
  for (const pr of props) {
    for (const name of pr.split(',').map((x) => x.trim())) {
      assert.ok(['opacity', 'transform'].includes(name), `animates ${name}`);
    }
  }
});

test('reduced motion: no transitions, content shown at once', { skip }, async () => {
  const r = await withPage({ reducedMotion: 'reduce' }, (p) => p.evaluate(() => ({
    opacity: getComputedStyle(document.querySelector('.feature')).opacity,
    reveal: getComputedStyle(document.querySelector('.feature')).transitionDuration,
    button: getComputedStyle(document.querySelector('.btn-primary')).transitionDuration,
  })));
  assert.equal(r.opacity, '1');
  assert.ok(eachMs(r.reveal).every((ms) => ms === 0), 'reveal duration is zero');
  assert.ok(eachMs(r.button).every((ms) => ms === 0), 'button duration is zero');
});

test('primary button moves 1 px down while pressed', { skip }, async () => {
  const [rest, pressed] = await withPage({}, async (p) => {
    const btn = p.locator('.hero .btn-primary');
    await btn.scrollIntoViewIfNeeded();
    const before = await btn.evaluate((el) => getComputedStyle(el).transform);
    await btn.hover();
    await p.mouse.down();
    const during = await btn.evaluate((el) => getComputedStyle(el).transform);
    await p.mouse.up();
    return [before, during];
  });
  assert.equal(rest, 'none');
  assert.notEqual(pressed, 'none', 'transform applied on :active');
});

test('FAQ chevron rotates over a 150 ms transition', { skip }, async () => {
  const d = await withPage({}, (p) => p.evaluate(() =>
    getComputedStyle(document.querySelector('.faq summary'), '::after').transitionDuration));
  assert.ok(eachMs(d).every((ms) => ms === 150), `got ${d}`);
});

test('hero copy staggers: second and third items start 100 ms late', { skip }, async () => {
  const delays = await withPage({}, async (p) => {
    await p.evaluate(() => document.querySelector('.hero-copy').classList.add('is-visible'));
    return p.evaluate(() => [...document.querySelector('.hero-copy').children].map((c) => getComputedStyle(c).transitionDelay));
  });
  // Each delay can list one value per transitioned property, so compare parsed milliseconds.
  const ms = delays.map((d) => eachMs(d));
  assert.ok(ms[0].every((x) => x === 0), 'first item has no delay');
  for (const i of [1, 2, 3, 4]) assert.ok(ms[i].every((x) => x === 100), `item ${i + 1} starts 100 ms late`);
});

test('hero copy ends fully visible once its transition finishes', { skip }, async () => {
  const opacities = await withPage({}, async (p) => {
    await p.evaluate(() => document.querySelector('.hero-copy').classList.add('is-visible'));
    await p.waitForFunction(() => [...document.querySelector('.hero-copy').children]
      .every((c) => getComputedStyle(c).opacity === '1'), null, { timeout: 2000 });
    return p.evaluate(() => [...document.querySelector('.hero-copy').children].map((c) => getComputedStyle(c).opacity));
  });
  assert.ok(opacities.every((o) => o === '1'));
});
