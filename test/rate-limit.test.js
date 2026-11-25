'use strict';
// Per-member rate limits on the two abuse-prone routes: creating invites (email) and member search.
// The limiter is in memory per serverless instance, so these tests cover one instance's behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/harness');
const { createRateLimiter } = require('../src/rate-limit');

test('invites are rate limited per member', async () => {
  const s = await setup({ rateLimits: { invites: { max: 2, windowMs: 60000 } } });
  try {
    await s.call('ann', 'GET', '/me');
    await s.call('bo', 'GET', '/me');
    const invite = (who, n) => s.call(who, 'POST', '/invites', { email: `guest${n}@example.com` });
    assert.equal((await invite('ann', 1)).status, 201);
    assert.equal((await invite('ann', 2)).status, 201);
    const blocked = await invite('ann', 3);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    // A different member has their own allowance.
    assert.equal((await invite('bo', 4)).status, 201);
  } finally { await s.close(); }
});

test('member search is rate limited per member', async () => {
  const s = await setup({ rateLimits: { search: { max: 2, windowMs: 60000 } } });
  try {
    await s.call('ann', 'GET', '/me');
    assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 200);
    assert.equal((await s.call('ann', 'GET', '/users?q=an')).status, 200);
    const blocked = await s.call('ann', 'GET', '/users?q=an');
    assert.equal(blocked.status, 429);
    assert.equal((await s.call('bo', 'GET', '/users?q=an')).status, 200, 'another member is not affected');
  } finally { await s.close(); }
});

test('the limit resets when the window ends', () => {
  let t = 0;
  const limit = createRateLimiter({ windowMs: 1000, max: 1, key: () => 'k', now: () => t });
  const run = () => {
    let status = 200;
    const res = { set() {}, status(c) { status = c; return this; }, json() { return this; } };
    limit({}, res, () => {});
    return status;
  };
  assert.equal(run(), 200);
  assert.equal(run(), 429);
  t = 1000;
  assert.equal(run(), 200, 'a new window starts after the reset time');
});
