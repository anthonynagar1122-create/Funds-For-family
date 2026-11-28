'use strict';
// G-12: Terms and Privacy are static pages at /terms and /privacy, linked from the landing footer and the sign-in
// screen. One source of text: public/app/pages/legal.js. The static pages are generated from it by
// scripts/build-legal.js (npm run build:legal) and must never drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderStaticPage } = require('../scripts/build-legal');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8');

for (const kind of ['terms', 'privacy']) {
  test(`/${kind} is a static page generated from the app's legal text (no drift)`, () => {
    assert.equal(read(`${kind}/index.html`), renderStaticPage(kind), `run: node scripts/build-legal.js`);
  });

  test(`/${kind} keeps the draft-pending-lawyer-review note, a heading, and a way back`, () => {
    const html = read(`${kind}/index.html`);
    assert.match(html, /has not yet been reviewed by a lawyer/);
    assert.match(html, kind === 'terms' ? /<h1[^>]*>Terms of use<\/h1>/ : /<h1[^>]*>Privacy notice<\/h1>/);
    assert.match(html, /href="\/"/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://funds-for-family\\.vercel\\.app/${kind}/?">`));
    assert.doesNotMatch(html, /<script/i, 'static legal pages need no script (CSP is script-src self)');
    assert.doesNotMatch(html, /href="#\//, 'in-app hash links must be rewritten to real URLs');
  });
}

test('the two static pages link to each other', () => {
  assert.match(read('terms/index.html'), /href="\/privacy\/"/);
  assert.match(read('privacy/index.html'), /href="\/terms\/"/);
});

test('the landing footer links to Terms and Privacy', () => {
  const html = read('index.html');
  const footer = html.slice(html.indexOf('<footer'));
  assert.match(footer, /<a href="\/terms\/?">Terms<\/a>/);
  assert.match(footer, /<a href="\/privacy\/?">Privacy<\/a>/);
});

test('the sign-in screen links to Terms and Privacy', () => {
  const html = read('app/index.html');
  const panel = html.slice(html.indexOf('id="signed-out"'), html.indexOf('id="view-home"'));
  assert.match(panel, /href="#\/terms"/);
  assert.match(panel, /href="#\/privacy"/);
});

test('sitemap.xml lists /terms and /privacy', () => {
  const sm = read('sitemap.xml');
  assert.match(sm, /<loc>https:\/\/funds-for-family\.vercel\.app\/terms\/<\/loc>/);
  assert.match(sm, /<loc>https:\/\/funds-for-family\.vercel\.app\/privacy\/<\/loc>/);
});
