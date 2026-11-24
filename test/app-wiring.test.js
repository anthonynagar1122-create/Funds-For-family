'use strict';
// Guards the wiring between the app page and the card model, so the cards cannot silently disappear.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(p, 'utf8');

test('the app page loads the card model before the app script', () => {
  const html = read(path.join(APP, 'index.html'));
  const model = html.indexOf('/app/card-model.js');
  const app = html.indexOf('/app.js');
  assert.ok(model > -1, 'card model loaded');
  assert.ok(app > model, 'loaded before app.js');
});

test('feed cards are built from the card model, not hand-written status markup', () => {
  const js = read(path.join(__dirname, '..', 'public', 'app.js'));
  assert.match(js, /CardModel\.requestCard\(/);
  const feed = js.slice(js.indexOf('async function renderFeed'), js.indexOf('// ---- New request'));
  assert.match(feed, /CardModel\.requestCard\(/, 'feed renderer uses the model');
  assert.match(feed, /progressPct/, 'feed shows progress');
});
