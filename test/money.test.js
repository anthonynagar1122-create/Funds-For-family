const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatInr, parseRupees } = require('../public/app/money.js');

test('formatInr uses Indian grouping with two decimals', () => {
  assert.equal(formatInr(0), '₹0.00');
  assert.equal(formatInr(150), '₹1.50');
  assert.equal(formatInr(5000000), '₹50,000.00');
  assert.equal(formatInr(10000000), '₹1,00,000.00');
  assert.equal(formatInr(123456789), '₹12,34,567.89');
});

test('formatInr puts a leading minus on negative amounts', () => {
  assert.equal(formatInr(-150), '-₹1.50');
});

test('parseRupees accepts Indian-style input', () => {
  assert.deepEqual(parseRupees('1,500'), { paise: 150000 });
  assert.deepEqual(parseRupees('₹1,500.50'), { paise: 150050 });
  assert.deepEqual(parseRupees(' 500 '), { paise: 50000 });
  assert.deepEqual(parseRupees(500), { paise: 50000 });
  assert.deepEqual(parseRupees('0.1'), { paise: 10 });
});

test('parseRupees rejects invalid input with an error string', () => {
  for (const bad of ['1.234', '-5', 'abc', '', '0', null, '1e3']) {
    const r = parseRupees(bad);
    assert.equal(typeof r.error, 'string', `expected error for ${JSON.stringify(bad)}`);
    assert.equal('paise' in r, false);
  }
});
