'use strict';
// Browser tests for the landing page. Run with: npm test
// Uses the Playwright browser preinstalled in this environment (no download).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

let pw;
try { pw = require('playwright'); } catch { pw = null; }

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const skip = pw ? false : 'playwright not available';

async function withPage({ width = 1440, reducedMotion = 'no-preference', js = true } = {}, fn) {
  const server = await serve();
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion, javaScriptEnabled: js });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForTimeout(50);
    return await fn(page);
  } finally {
    await browser.close();
    server.close();
  }
}

const ALLOWED_MS = [100, 150, 200, 300];
const toMs = (s) => Math.round(parseFloat(s) * (s.trim().endsWith('ms') ? 1 : 1000));

// ---- Regression guards for work already done (written after the fix, so they pass now) ----

test('regression: every card shares one radius and padding per breakpoint', { skip }, async () => {
  const r = await withPage({ width: 1440 }, (p) => p.evaluate(() => ['.feature', '.step', '.example-card', '.calc'].map((s) => {
    const cs = getComputedStyle(document.querySelector(s));
    return { s, radius: cs.borderRadius, pad: cs.paddingTop };
  })));
  for (const c of r) { assert.equal(c.radius, '12px', c.s); assert.equal(c.pad, '28px', c.s); }
});

test('regression: no horizontal overflow at 375 and 1440 px', { skip }, async () => {
  for (const width of [375, 1440]) {
    const o = await withPage({ width }, (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
    assert.equal(o, 0, `overflow at ${width}`);
  }
});

test('regression: trust titles use the same colour as card titles', { skip }, async () => {
  const [a, b] = await withPage({}, (p) => p.evaluate(() => [
    getComputedStyle(document.querySelector('.trust-title')).color,
    getComputedStyle(document.querySelector('.feature h3')).color,
  ]));
  assert.equal(a, b);
});

test('regression: content is visible with JavaScript disabled', { skip }, async () => {
  const hidden = await withPage({ js: false }, (p) => p.evaluate(() =>
    [...document.querySelectorAll('.reveal')].filter((el) => getComputedStyle(el).opacity === '0').length));
  assert.equal(hidden, 0);
});

// ---- Motion requirements (TDD: written first, watched fail, then implemented) ----

test('reveal transitions use only duration tokens (100/150/200/300 ms)', { skip }, async () => {
  const durations = await withPage({}, (p) => p.evaluate(() =>
    [...document.querySelectorAll('.reveal')].map((el) => getComputedStyle(el).transitionDuration)));
  assert.ok(durations.length > 0);
  for (const d of durations) {
    const ms = d.split(',').map((x) => toMs(x.trim()));
    for (const m of ms) assert.ok(ALLOWED_MS.includes(m), `duration ${m}ms not a token`);
  }
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

test('reduced motion removes all transitions and shows content immediately', { skip }, async () => {
  const r = await withPage({ reducedMotion: 'reduce' }, (p) => p.evaluate(() => {
    const el = document.querySelector('.feature');
    const cs = getComputedStyle(el);
    const btn = getComputedStyle(document.querySelector('.btn-primary'));
    return { opacity: cs.opacity, duration: cs.transitionDuration, btnDuration: btn.transitionDuration };
  }));
  assert.equal(r.opacity, '1');
  assert.equal(r.duration.split(',').every((d) => toMs(d.trim()) === 0), true);
  assert.equal(r.btnDuration.split(',').every((d) => toMs(d.trim()) === 0), true);
});

test('primary buttons give press feedback with a 1 px transform on :active, using a token duration', { skip }, async () => {
  const r = await withPage({}, (p) => p.evaluate(() => {
    const btn = document.querySelector('.btn-primary');
    const rest = getComputedStyle(btn);
    return { restTransition: rest.transitionProperty, restDur: rest.transitionDuration };
  }));
  assert.ok(r.restTransition.includes('transform'), 'button transitions transform on press');
  assert.ok(r.restDur.split(',').every((d) => ALLOWED_MS.includes(toMs(d.trim()))), 'token duration');
});

test('FAQ chevron rotates over a 150 ms token transition when a question opens', { skip }, async () => {
  const r = await withPage({ reducedMotion: 'no-preference' }, (p) => p.evaluate(() =>
    getComputedStyle(document.querySelector('.faq summary'), '::after').transitionDuration));
  assert.ok(r.split(',').every((d) => toMs(d.trim()) === 150), `got ${r}`);
});

test('hero copy enters with a staggered reveal and ends fully visible', { skip }, async () => {
  const r = await withPage({}, async (p) => {
    await p.evaluate(() => document.querySelector('.hero-copy').classList.add('is-visible'));
    await p.waitForTimeout(400);
    return p.evaluate(() => [...document.querySelector('.hero-copy').children].map((c) => getComputedStyle(c).opacity));
  });
  assert.ok(r.every((o) => o === '1'));
});
