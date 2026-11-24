'use strict';
// The request detail page must take its role-based actions from the card model, not its own copy of the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const detail = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'pages', 'request.js'), 'utf8');

test('the detail page builds its actions from the card model', () => {
  assert.match(detail, /CardModel\.requestCard\(/);
});

test('the detail page no longer keeps its own verify gate', () => {
  assert.doesNotMatch(detail, /const canVerify = /);
  assert.doesNotMatch(detail, /alreadyVerified/);
});
