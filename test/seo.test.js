'use strict';
// The site is a private, invitation-only app (design 2026-11-24, option A): it must stay out of search indexes,
// while link previews in chat apps still get a title and image. File-based: no browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');
const meta = (html, attr, key) => {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`));
  return m ? m[1] : null;
};

test('every HTML page asks search engines not to index it', () => {
  for (const page of ['index.html', 'app/index.html']) {
    assert.equal(meta(read(page), 'name', 'robots'), 'noindex', page);
  }
});

// Crawlers must be allowed to fetch pages, or they never see "noindex" (and link-preview bots that obey robots.txt fail).
test('robots.txt lets crawlers read the noindex tag and no sitemap is published', () => {
  const robots = read('robots.txt');
  assert.match(robots, /^User-agent: \*$/m);
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m);
  assert.doesNotMatch(robots, /Sitemap:/);
  assert.equal(fs.existsSync(path.join(PUBLIC, 'sitemap.xml')), false);
});

test('link previews: the home page declares a title and an absolute og:image', () => {
  const html = read('index.html');
  assert.ok(meta(html, 'property', 'og:title'));
  assert.match(meta(html, 'property', 'og:image') || '', /^https:\/\/.+\/og-image\.png$/);
});

test('the og-image file exists and is a 1200 by 630 PNG', () => {
  const file = path.join(PUBLIC, 'og-image.png');
  assert.ok(fs.existsSync(file), 'og-image.png is committed');
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});

test('the old /app/ address redirects to the app and keeps the link target', () => {
  assert.match(read('app/index.html'), /<script src="\/app\/redirect\.js"><\/script>/);
  assert.match(read('app/redirect.js'), /location\.replace\('\/' \+ location\.search \+ location\.hash\)/);
});

test('home page heading hierarchy: one h1 per view, and no heading level is skipped inside a view', () => {
  const html = read('index.html');
  const sections = [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)].map((m) => m[0]);
  assert.ok(sections.length >= 6, 'views are sections');
  for (const sec of sections) {
    const levels = [...sec.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    if (levels.length === 0) continue;
    assert.equal(levels.filter((l) => l === 1).length, 1, `one h1 in ${sec.slice(0, 40)}`);
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} → h${levels[i]}`);
  }
});
