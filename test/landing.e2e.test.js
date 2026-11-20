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

// ---- Motion effects on the landing page (TDD: written before integration) ----
// Chosen approach (B): zoom on all cards; spotlight and tilt on the four step cards;
// magnetic pull on the two primary CTAs. Nothing loops; reduced motion disables movement.

test('effects: feature cards zoom from 0.96 to rest as they scroll in', { skip }, async () => {
  // Feature cards sit below the first viewport, so their starting state is observable.
  const [start, end] = await withPage({}, async (p) => {
    await p.waitForSelector('html.js');
    const card = p.locator('.feature').first();
    // Read the resting start state deterministically: no transition, no visible class.
    const before = await card.evaluate((el) => {
      el.style.transition = 'none';
      el.classList.remove('is-visible');
      const t = getComputedStyle(el).transform;
      el.style.transition = '';
      return t;
    });
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.feature')).transform === 'none', null, { timeout: 2000 });
    return [before, await card.evaluate((el) => getComputedStyle(el).transform)];
  });
  // Must start from a 0.96 scale, not the old 8 px translate used by the reveal.
  assert.match(start, /^matrix\(0\.96,/, `starts at ${start}`);
  assert.equal(end, 'none', 'ends at rest');
});

test('effects: step cards carry the pointer spotlight', { skip }, async () => {
  const vars = await withPage({}, async (p) => {
    const card = p.locator('.step').first();
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4, { steps: 3 });
    return card.evaluate((el) => [el.style.getPropertyValue('--mx'), el.style.getPropertyValue('--my')]);
  });
  assert.match(vars[0], /%$/);
  assert.match(vars[1], /%$/);
});

test('effects: a hovered step card tilts and returns flat on leave', { skip }, async () => {
  const [hovered, left] = await withPage({}, async (p) => {
    const card = p.locator('.step').first();
    await card.scrollIntoViewIfNeeded();
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.step')).transform === 'none', null, { timeout: 2000 });
    const box = await card.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await p.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 8 });
    await p.waitForTimeout(200);
    const h = await card.evaluate((el) => getComputedStyle(el).transform);
    await p.mouse.move(2, 2, { steps: 3 });
    await p.waitForTimeout(200);
    return [h, await card.evaluate((el) => getComputedStyle(el).transform)];
  });
  assert.notEqual(hovered, 'none', 'tilted');
  assert.equal(left, 'none', 'flat after leave');
});

test('effects: step tilt never exceeds 4 degrees', { skip }, async () => {
  const max = await withPage({}, async (p) => {
    const card = p.locator('.step').first();
    await card.scrollIntoViewIfNeeded();
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.step')).transform === 'none', null, { timeout: 2000 });
    const box = await card.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await p.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.05, { steps: 8 });
    await p.waitForTimeout(200);
    return card.evaluate((el) => Math.max(
      Math.abs(parseFloat(el.style.getPropertyValue('--rx') || '0')),
      Math.abs(parseFloat(el.style.getPropertyValue('--ry') || '0'))));
  });
  assert.ok(max > 0 && max <= 4, `tilt ${max}deg`);
});

test('effects: the hero CTA leans toward the pointer by at most 4 px', { skip }, async () => {
  const dx = await withPage({}, async (p) => {
    const btn = p.locator('.hero .btn-primary');
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

test('effects: reduced motion disables tilt, magnetic pull and zoom', { skip }, async () => {
  const r = await withPage({ reducedMotion: 'reduce' }, async (p) => {
    const step = p.locator('.step').first();
    await step.scrollIntoViewIfNeeded();
    const box = await step.boundingBox();
    await p.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 4 });
    await p.waitForTimeout(150);
    const tilt = await step.evaluate((el) => getComputedStyle(el).transform);
    const btn = p.locator('.hero .btn-primary');
    const bb = await btn.boundingBox();
    await p.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2, { steps: 4 });
    await p.waitForTimeout(150);
    const mag = await btn.evaluate((el) => getComputedStyle(el).transform);
    const zoom = await p.locator('.step').nth(1).evaluate((el) => getComputedStyle(el).transform);
    return { tilt, mag, zoom };
  });
  assert.equal(r.tilt, 'none');
  assert.equal(r.mag, 'none');
  assert.equal(r.zoom, 'none');
});

test('effects: nothing on the landing page animates forever', { skip }, async () => {
  const count = await withPage({}, async (p) => {
    await p.waitForTimeout(600);
    return p.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length);
  });
  assert.equal(count, 0);
});

test('effects: every landing transition duration is a token (0/100/150/200/300 ms)', { skip }, async () => {
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

// ---- Critique findings (docs/13-landing-effects.md) ----

test('critique: the FAQ aligns to the main grid, like the other sections', { skip }, async () => {
  const [faq, hero] = await withPage({ width: 1440 }, (p) => p.evaluate(() => [
    Math.round(document.querySelector('#faq .container').getBoundingClientRect().left),
    Math.round(document.querySelector('.hero .container').getBoundingClientRect().left),
  ]));
  assert.equal(faq, hero, `FAQ left ${faq}px vs hero ${hero}px`);
});

test('critique: final-CTA disclaimer meets 4.5:1 contrast on the brand background', { skip }, async () => {
  const ratio = await withPage({ width: 1440 }, (p) => p.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const el = document.querySelector('.final-cta .disclaimer');
    const fg = lum(getComputedStyle(el).color);
    const bg = lum(getComputedStyle(document.querySelector('.final-cta')).backgroundColor);
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return (hi + 0.05) / (lo + 0.05);
  }));
  assert.ok(ratio >= 4.5, `contrast ${ratio.toFixed(2)}:1`);
});
