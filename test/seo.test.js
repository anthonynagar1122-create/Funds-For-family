'use strict';
// SEO checks for the public pages. File-based: no browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const SITE = 'https://funds-for-family.vercel.app';
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');
const meta = (html, attr, key) => {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`));
  return m ? m[1] : null;
};
const landing = () => read('index.html');

test('title is 50 to 60 characters', () => {
  const t = landing().match(/<title>(.*?)<\/title>/)[1];
  assert.ok(t.length >= 50 && t.length <= 60, `${t.length} chars`);
});

test('meta description is 150 to 160 characters', () => {
  const d = meta(landing(), 'name', 'description');
  assert.ok(d && d.length >= 150 && d.length <= 160, `${d && d.length} chars`);
});

test('canonical URL is absolute and points at the site root', () => {
  const m = landing().match(/<link rel="canonical" href="([^"]+)"/);
  assert.equal(m && m[1], `${SITE}/`);
});

test('Open Graph: url matches canonical and an absolute og:image is declared', () => {
  const html = landing();
  assert.equal(meta(html, 'property', 'og:url'), `${SITE}/`);
  const img = meta(html, 'property', 'og:image');
  assert.equal(img, `${SITE}/og-image.png`);
  assert.equal(meta(html, 'property', 'og:image:width'), '1200');
  assert.equal(meta(html, 'property', 'og:image:height'), '630');
});

test('the og-image file exists and is a 1200 by 630 PNG', () => {
  const file = path.join(PUBLIC, 'og-image.png');
  assert.ok(fs.existsSync(file), 'og-image.png is committed');
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(16), 1200, 'width');
  assert.equal(buf.readUInt32BE(20), 630, 'height');
});

test('Twitter card: summary_large_image with title, description and image', () => {
  const html = landing();
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
  assert.ok(meta(html, 'name', 'twitter:title'));
  assert.ok(meta(html, 'name', 'twitter:description'));
  assert.equal(meta(html, 'name', 'twitter:image'), `${SITE}/og-image.png`);
});

test('structured data: valid JSON-LD with Organization and SoftwareApplication', () => {
  const m = landing().match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'JSON-LD block present');
  const data = JSON.parse(m[1]);
  const graph = data['@graph'] || [data];
  const org = graph.find((n) => n['@type'] === 'Organization');
  const app = graph.find((n) => n['@type'] === 'SoftwareApplication');
  assert.ok(org && org.name === 'Funds For Family' && org.url === `${SITE}/`);
  assert.ok(app && app.name === 'Funds For Family' && app.applicationCategory === 'FinanceApplication');
  assert.equal(app.operatingSystem, 'Web');
  assert.ok(!('offers' in app), 'no price claim unless one is confirmed');
});

test('robots.txt allows the site, blocks the private app, and points to the sitemap', () => {
  const robots = read('robots.txt');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/app\/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
});

test('sitemap.xml lists the public landing page with its canonical URL', () => {
  const xml = read('sitemap.xml');
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, new RegExp(`<loc>${SITE.replace(/\./g, '\\.')}/</loc>`));
  assert.doesNotMatch(xml, /\/app\//, 'private app is not listed');
});

test('the signed-in app and the prototype are kept out of search indexes', () => {
  assert.equal(meta(read('app/index.html'), 'name', 'robots'), 'noindex');
  assert.equal(meta(read('prototype/index.html'), 'name', 'robots'), 'noindex');
});

test('landing heading hierarchy: one h1, and no heading level is skipped', () => {
  const html = landing();
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1, 'exactly one h1');
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} followed by h${levels[i]}`);
  }
});

test('every image on the landing page has alt text or is decorative', () => {
  const imgs = [...landing().matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of imgs) assert.match(tag, /\balt="/, tag);
});
