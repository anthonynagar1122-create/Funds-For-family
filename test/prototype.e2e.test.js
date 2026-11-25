'use strict';
// Motion prototype tests. Each test reads only what a visitor can observe: computed styles and CSS custom properties.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const skip = pw ? false : 'playwright not available';

let server = null;
let browser = null;
const PAGE = '/prototype/';

test.before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    let rel = req.url.split('?')[0];
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function withPage({ reducedMotion = 'no-preference', js = true } = {}, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion, javaScriptEnabled: js });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`http://127.0.0.1:${server.address().port}${PAGE}`, { waitUntil: 'load' });
    return await fn(page);
  } finally { await ctx.close(); }
}

// Bring the first tilt card to rest in view, then enter it at a fraction of its width and height.
async function enterTiltCard(p, fx, fy) {
  const card = p.locator('[data-tilt]').first();
  await card.scrollIntoViewIfNeeded();
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-tilt]')).transform === 'none', null, { timeout: 3000 });
  await p.waitForTimeout(50);
  const box = await card.boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await p.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 8 });
  await p.waitForTimeout(200);
  return card;
}

test('prototype page loads with one h1 and no script errors', { skip }, async () => {
  const errors = [];
  const count = await withPage({}, async (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    return p.locator('h1').count();
  });
  assert.equal(count, 1);
  assert.deepEqual(errors, []);
});

test('scroll reveal: cards start at scale 0.96 and settle to 1', { skip }, async () => {
  const [start, end] = await withPage({}, async (p) => {
    const card = p.locator('[data-zoom]').first();
    const before = await card.evaluate((el) => getComputedStyle(el).transform);
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-zoom]')).transform === 'none', null, { timeout: 2000 });
    return [before, await card.evaluate((el) => getComputedStyle(el).transform)];
  });
  assert.notEqual(start, 'none', 'starts transformed');
  assert.equal(end, 'none', 'ends at rest');
});

test('spotlight: pointer position is written to --mx and --my on the card', { skip }, async () => {
  const vars = await withPage({}, async (p) => {
    const card = p.locator('[data-spotlight]').first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    await p.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5, { steps: 3 });
    return card.evaluate((el) => [el.style.getPropertyValue('--mx'), el.style.getPropertyValue('--my')]);
  });
  assert.match(vars[0], /%$/);
  assert.match(vars[1], /%$/);
});

test('tilt: a hovered card rotates in 3D and returns flat on leave', { skip }, async () => {
  const [hovered, left] = await withPage({}, async (p) => {
    const card = await enterTiltCard(p, 0.9, 0.1);
    const h = await card.evaluate((el) => getComputedStyle(el).transform);
    await p.mouse.move(2, 2, { steps: 3 });
    await p.waitForTimeout(200);
    return [h, await card.evaluate((el) => getComputedStyle(el).transform)];
  });
  assert.notEqual(hovered, 'none', 'tilted while hovered');
  assert.equal(left, 'none', 'flat after leave');
});

test('tilt is limited to 4 degrees', { skip }, async () => {
  const max = await withPage({}, async (p) => {
    const card = await enterTiltCard(p, 0.97, 0.03);
    return card.evaluate((el) => Math.max(
      Math.abs(parseFloat(el.style.getPropertyValue('--rx') || '0')),
      Math.abs(parseFloat(el.style.getPropertyValue('--ry') || '0'))));
  });
  assert.ok(max > 0 && max <= 4, `tilt ${max}deg`);
});

test('magnetic CTA moves toward the pointer by at most 4 px', { skip }, async () => {
  const dx = await withPage({}, async (p) => {
    const btn = p.locator('[data-magnetic]').first();
    await btn.scrollIntoViewIfNeeded();
    const box = await btn.boundingBox();
    await p.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
    await p.waitForTimeout(200);
    return btn.evaluate((el) => {
      const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
      return m ? Math.abs(parseFloat(m[1].split(',')[4])) : 0;
    });
  });
  assert.ok(dx > 0 && dx <= 4, `moved ${dx}px`);
});

test('reduced motion: no tilt, no magnetic pull, no zoom', { skip }, async () => {
  const r = await withPage({ reducedMotion: 'reduce' }, async (p) => {
    const card = p.locator('[data-tilt]').first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    await p.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 4 });
    await p.waitForTimeout(150);
    const tilt = await card.evaluate((el) => getComputedStyle(el).transform);
    const btn = p.locator('[data-magnetic]').first();
    const bb = await btn.boundingBox();
    await p.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2, { steps: 4 });
    await p.waitForTimeout(150);
    const mag = await btn.evaluate((el) => getComputedStyle(el).transform);
    const zoom = await p.locator('[data-zoom]').first().evaluate((el) => getComputedStyle(el).transform);
    return { tilt, mag, zoom };
  });
  assert.equal(r.tilt, 'none');
  assert.equal(r.mag, 'none');
  assert.equal(r.zoom, 'none');
});

test('no infinite animations anywhere on the prototype', { skip }, async () => {
  const count = await withPage({}, async (p) => {
    await p.waitForTimeout(600);
    return p.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length);
  });
  assert.equal(count, 0);
});

test('every transition duration on the prototype is a token (0/100/150/200/300 ms)', { skip }, async () => {
  const durations = await withPage({}, (p) => p.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll('*')) {
      for (const d of getComputedStyle(el).transitionDuration.split(',')) {
        out.add(Math.round(parseFloat(d) * (d.includes('ms') ? 1 : 1000)));
      }
    }
    return [...out];
  }));
  for (const ms of durations) assert.ok([0, 100, 150, 200, 300].includes(ms), `${ms}ms`);
});

test('content is visible with JavaScript disabled', { skip }, async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  try {
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${server.address().port}${PAGE}`, { waitUntil: 'load' });
    const hidden = await p.evaluate(() => [...document.querySelectorAll('[data-zoom]')]
      .filter((el) => getComputedStyle(el).opacity === '0').length);
    assert.equal(hidden, 0);
  } finally { await ctx.close(); }
});
