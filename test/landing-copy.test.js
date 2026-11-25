'use strict';
// Landing copy must match the owner's product decisions (docs/15-product-decisions.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// Visible text plus attribute text (meta content, aria labels, JSON-LD), tags removed.
const text = html.replace(/<[^>]*?(content|aria-label|alt)="([^"]*)"[^>]*>/g, ' $2 ').replace(/<[^>]+>/g, ' ');

test('copy: P-2 amounts are in rupees, never dollars', () => {
  assert.doesNotMatch(text, /\$\s?\d/, 'a dollar amount is still shown');
  assert.match(text, /₹\d{1,3}(,\d{2})*,\d{3}(\.\d{2})?/, 'no rupee amount with Indian grouping');
});

test('copy: P-16 shows the request limit and repayment window', () => {
  assert.match(text, /₹50,000/);
  assert.match(text, /12 months/);
});

test('copy: P-6 no interest is charged or described as accruing', () => {
  assert.doesNotMatch(text, /\d+%\s*a year/i, 'an interest rate is still quoted');
  assert.doesNotMatch(text, /interest (starts|accrues)/i);
  assert.doesNotMatch(html, /href="#interest"/, 'nav still links to an interest section');
  assert.match(text, /no interest/i);
});

test('copy: P-3 says "trusted contact", never nominee or guarantor', () => {
  assert.doesNotMatch(text, /nominee/i);
  assert.doesNotMatch(text, /guarantor/i);
  assert.doesNotMatch(text, /repays? if the borrower/i, 'the trusted contact must not be described as liable');
  assert.match(text, /trusted contact/i);
});

test('copy: P-1 says the app does not move money', () => {
  assert.match(text, /does not move money/i);
});

test('copy: P-9 explains the two-step sent and received confirmation', () => {
  assert.match(text, /sent/i);
  assert.match(text, /received/i);
  assert.match(text, /only confirmed amounts/i);
});

test('copy: P-7 and P-8 describe mutual connections and invite-only joining', () => {
  assert.match(text, /follow each other/i);
  assert.match(text, /invit/i);
});
